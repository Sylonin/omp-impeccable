import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type {
  ExtensionAPI,
  ExtensionContext,
  RegisteredCommand,
  ToolDefinition,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import { describe, expect, onTestFinished, test, vi } from 'vitest';

import impeccableExtension, {
  browserCommand,
  ompAgent,
  parseCommandMetadata,
  summarizeLiveStatus,
} from '../extensions/impeccable.ts';

const root = path.resolve(import.meta.dirname, '..');

describe('impeccable extension', () => {
  test('package exposes the OMP extensions without vendoring Impeccable', () => {
    const pkg = readPackageJson();

    expect(pkg.omp.extensions).toEqual(['./extensions/impeccable.ts']);
    for (const excluded of [
      '.omp/skills',
      '.agents/skills',
      '.github/skills',
      'vendor',
    ]) {
      expect(pkg.files).not.toContain(excluded);
    }
  });

  test('resources_discover publishes the installed project OMP skill path', async () => {
    const { project, skillRoot } = makeProject();
    const legacySkillRoot = path.join(
      project,
      '.agents',
      'skills',
      'impeccable',
    );
    fs.mkdirSync(path.join(legacySkillRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(legacySkillRoot, 'SKILL.md'),
      '# legacy impeccable\n',
    );
    const nested = path.join(project, 'src', 'pages');
    fs.mkdirSync(nested, { recursive: true });
    const harness = loadExtension();

    const result = await harness.emit<ResourcesDiscoverResult>(
      'resources_discover',
      { cwd: nested },
    );

    expect(skillRoot).toBe(path.join(project, '.omp', 'skills', 'impeccable'));
    expect(result).toEqual({ skillPaths: [skillRoot] });
    expect(result?.skillPaths).not.toContain(legacySkillRoot);
  });

  test('agent commands copy a legacy project .agents skill into .omp', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-impeccable-'));
    const legacySkillRoot = path.join(
      project,
      '.agents',
      'skills',
      'impeccable',
    );
    const skillRoot = path.join(project, '.omp', 'skills', 'impeccable');
    fs.mkdirSync(path.join(project, '.git'));
    fs.mkdirSync(path.join(legacySkillRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(legacySkillRoot, 'SKILL.md'),
      'Run `.agents/skills/impeccable/scripts/impeccable live-poll`.\n',
    );
    onTestFinished(() => fs.rmSync(project, { recursive: true, force: true }));
    const harness = loadExtension();
    const ctx = makeContext(project, { idle: false });

    await runCommand(harness, 'audit src/App.tsx', ctx);

    expect(fs.existsSync(path.join(skillRoot, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(legacySkillRoot)).toBe(true);
    expect(fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8')).toContain(
      '.omp/skills/impeccable/scripts/impeccable live-poll',
    );
    expect(harness.messages[0]?.message.content).toMatch(
      new RegExp(escapeRegExp(skillRoot)),
    );
  });

  test('argument completions prefer installed command metadata', async () => {
    const { project, skillRoot } = makeProject();
    fs.writeFileSync(
      path.join(skillRoot, 'SKILL.md'),
      `
| Command | Category | Description | Reference |
|---|---|---|---|
| \`craft [feature]\` | Build | Short table description | [reference/craft.md](reference/craft.md) |
`,
    );
    fs.writeFileSync(
      path.join(skillRoot, 'scripts', 'command-metadata.json'),
      JSON.stringify({
        craft: {
          description:
            'Full metadata description with `code` and **emphasis**.',
        },
      }),
    );

    const descriptions = parseCommandMetadata(
      fs.readFileSync(
        path.join(skillRoot, 'scripts', 'command-metadata.json'),
        'utf8',
      ),
    );
    expect(descriptions.get('craft')).toBe(
      'Full metadata description with code and emphasis.',
    );

    const harness = loadExtension();
    await harness.emit('session_start', {}, makeContext(project));

    const [craft] = await argumentCompletions(harness, 'cr');

    expect(craft?.description).toBe(
      'Full metadata description with code and emphasis.',
    );
  });

  test('argument completions include fallback descriptions before skill install', async () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omp-impeccable-no-skill-'),
    );
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-impeccable-home-'));
    const oldHome = process.env.HOME;
    fs.mkdirSync(path.join(project, '.git'));
    process.env.HOME = home;
    onTestFinished(() => {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });

    const harness = loadExtension();
    await harness.emit('session_start', {}, makeContext(project));

    const craft = (await argumentCompletions(harness, 'cr')).find(
      ({ value }) => value === 'craft',
    );

    expect(craft?.description).toMatch(/confirmed-brief-then-build/);
  });

  test('pin creates an OMP command shortcut handled by the extension', async () => {
    const { project, skillRoot } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project, { idle: false });

    await runCommand(harness, 'pin audit', ctx);
    await runCommand(harness, 'pin audit', ctx);
    await harness.commands.get('audit')?.handler('src/App.tsx', ctx);

    const shortcut = fs.readFileSync(
      path.join(project, '.omp', 'commands', 'audit.md'),
      'utf8',
    );
    const [entry] = harness.messages;

    expect(shortcut).toContain('managed-by: omp-impeccable');
    expect(shortcut).toContain('impeccable-command: audit');
    expect(shortcut).toContain('$ARGUMENTS');
    expect(entry?.message.customType).toBe('impeccable-command');
    expect(entry?.message.content).toMatch(
      /Handle this Impeccable invocation in OMP: \/impeccable audit src\/App\.tsx/,
    );
    expect(entry?.message.content).toMatch(new RegExp(escapeRegExp(skillRoot)));
  });

  test('pin resolves OMP command shortcuts from the project root', async () => {
    const { project, skillRoot } = makeProject();
    const nested = path.join(project, 'src', 'pages');
    fs.mkdirSync(nested, { recursive: true });
    const ctx = makeContext(nested, { idle: false });

    await runCommand(loadExtension(), 'pin audit', ctx);

    const shortcut = path.join(project, '.omp', 'commands', 'audit.md');
    expect(fs.existsSync(shortcut)).toBe(true);
    expect(
      fs.existsSync(path.join(nested, '.omp', 'commands', 'audit.md')),
    ).toBe(false);

    const oldCwd = process.cwd();
    onTestFinished(() => process.chdir(oldCwd));
    process.chdir(nested);
    const harness = loadExtension();
    expect(harness.commands.has('audit')).toBe(true);
    await harness.commands.get('audit')?.handler('src/App.tsx', ctx);

    const [entry] = harness.messages;
    expect(entry?.message.customType).toBe('impeccable-command');
    expect(entry?.message.content).toMatch(
      /Handle this Impeccable invocation in OMP: \/impeccable audit src\/App\.tsx/,
    );
    expect(entry?.message.content).toMatch(new RegExp(escapeRegExp(skillRoot)));
  });

  test('factory restore does not require initialized getCommands', () => {
    const { project } = makeProject();
    const nested = path.join(project, 'src', 'pages');
    const auditFile = path.join(project, '.omp', 'commands', 'audit.md');
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      auditFile,
      `---
description: Run /impeccable audit through omp-impeccable
managed-by: omp-impeccable
impeccable-command: audit
---
`,
    );
    const oldCwd = process.cwd();
    onTestFinished(() => process.chdir(oldCwd));
    process.chdir(nested);

    const harness = loadExtension([], { getCommandsUnavailable: true });

    expect(harness.commands.has('audit')).toBe(true);
  });

  test('pin refuses slash commands owned by another extension', async () => {
    const { project } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project);
    harness.commands.set('audit', {
      description: 'Run another extension audit command',
      handler: () => undefined,
    });

    await runCommand(harness, 'pin audit', ctx);

    expect(ctx.ui.notifications.at(-1)).toEqual({
      message:
        'Cannot pin /audit; an OMP slash command with that name already exists.',
      type: 'warning',
    });
    expect(
      fs.existsSync(path.join(project, '.omp', 'commands', 'audit.md')),
    ).toBe(false);
  });

  test('pin refuses a pre-existing non-managed OMP command file', async () => {
    const { project } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project);
    const file = path.join(project, '.omp', 'commands', 'audit.md');
    const existing = `---
description: Existing audit command
---
Existing /audit command
`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, existing);

    await runCommand(harness, 'pin audit', ctx);

    expect(ctx.ui.notifications.at(-1)).toEqual({
      message: `Cannot overwrite existing OMP command file: ${file}`,
      type: 'warning',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(existing);
    expect(harness.commands.has('audit')).toBe(false);
  });

  test('pin accepts its managed OMP command file on reload', async () => {
    const { project } = makeProject();
    const ctx = makeContext(project);
    const file = path.join(project, '.omp', 'commands', 'audit.md');

    await runCommand(loadExtension(), 'pin audit', ctx);

    const harness = loadExtension([
      {
        name: 'audit',
        description: 'Run /impeccable audit through omp-impeccable',
        source: 'prompt',
        location: 'project',
        path: file,
      },
    ]);
    await harness.emit('session_start', {}, ctx);
    expect(harness.commands.has('audit')).toBe(true);

    await runCommand(harness, 'pin audit', ctx);

    expect(ctx.ui.notifications.at(-1)).toEqual({
      message: 'Pinned /audit to /impeccable audit in .omp/commands/audit.md.',
      type: 'info',
    });
  });

  test('restore skips non-managed command sources and command files', async () => {
    const { project } = makeProject();
    const ctx = makeContext(project);
    const auditFile = path.join(project, '.omp', 'commands', 'audit.md');
    const craftFile = path.join(project, '.omp', 'commands', 'craft.md');
    const foreignAuditFile = path.join(
      project,
      '.omp',
      'commands',
      'foreign-audit.md',
    );

    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.writeFileSync(
      auditFile,
      `---
description: Run /impeccable audit through omp-impeccable
managed-by: omp-impeccable
impeccable-command: audit
---
`,
    );
    fs.writeFileSync(
      craftFile,
      `---
description: Existing craft command
---
Existing /craft command
`,
    );
    fs.writeFileSync(
      foreignAuditFile,
      `---
description: Existing audit command
---
Existing /audit command
`,
    );

    const harness = loadExtension([
      {
        name: 'audit',
        description: 'Run an existing prompt audit command',
        source: 'prompt',
        location: 'project',
        path: foreignAuditFile,
      },
    ]);

    await harness.emit('session_start', {}, ctx);

    expect(harness.commands.has('audit')).toBe(false);
    expect(harness.commands.has('craft')).toBe(false);
    expect(harness.messages).toHaveLength(0);
  });

  test('hooks passes its arguments to the skill launcher and shows the output', async () => {
    const { project } = makeProject({
      hooks: 'console.log(`hooks:${process.argv.slice(2).join(",")}`);\n',
    });
    const harness = loadExtension();
    const ctx = makeContext(project);

    await runCommand(harness, 'hooks ignore-rule overused-font', ctx);

    expect(harness.messages.at(-1)?.message.content).toBe(
      'hooks:ignore-rule,overused-font',
    );
  });

  test('free-form requests and a bare /impeccable go to the skill instead of warning', async () => {
    const { project, skillRoot } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project);

    await runCommand(
      harness,
      'check whether image generation is available for this project',
      ctx,
    );
    await runCommand(harness, '', ctx);

    expect(ctx.ui.notifications).toEqual([]);
    expect(harness.messages.map((entry) => entry.message.content)).toEqual([
      expect.stringContaining(
        'Handle this Impeccable invocation in OMP: /impeccable check whether image generation is available for this project\n',
      ),
      expect.stringContaining(
        'Handle this Impeccable invocation in OMP: /impeccable\n',
      ),
    ]);
    expect(harness.messages[1]?.message.content).toContain(
      path.join(skillRoot, 'SKILL.md'),
    );
    await harness.emit('session_shutdown', {}, ctx);
  });

  test('design hook runs only after hooks on records consent', async () => {
    const { project } = makeProject({
      // Echo the event back as findings so the test can see what the hook received.
      hook: `
				let input = '';
				process.stdin.on('data', (chunk) => (input += chunk));
				process.stdin.on('end', () => {
					const event = JSON.parse(input);
					if (event.stop_hook_active) return;
					const target = event.tool_input?.file_path ?? 'stop';
					console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: \`findings:\${event.hook_event_name}:\${target}\` } }));
				});
			`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project);
    const toolResult = {
      toolName: 'edit',
      isError: false,
      input: {},
      content: [{ type: 'text', text: 'edited' }],
      details: {
        perFileResults: [{ path: 'src/a.css' }, { path: 'src/b.html' }],
      },
    };

    expect(await harness.emit('tool_result', toolResult, ctx)).toBeUndefined();
    await harness.emit('agent_end', { messages: [] }, ctx);
    expect(harness.messages).toEqual([]);

    fs.mkdirSync(path.join(project, '.impeccable'));
    fs.writeFileSync(
      path.join(project, '.impeccable', 'config.local.json'),
      JSON.stringify({ hook: { consent: 'accepted' } }),
    );

    expect(await harness.emit('tool_result', toolResult, ctx)).toEqual({
      content: [
        { type: 'text', text: 'edited' },
        {
          type: 'text',
          text: `findings:PostToolUse:${path.join(project, 'src/a.css')}\n\nfindings:PostToolUse:${path.join(project, 'src/b.html')}`,
        },
      ],
    });

    await harness.emit('agent_end', { messages: [] }, ctx);
    // The turn a Stop pass started ends with stop_hook_active, so it cannot loop.
    await harness.emit('agent_end', { messages: [] }, ctx);
    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]?.message).toMatchObject({
      customType: 'impeccable-hook',
      content: 'findings:Stop:stop',
    });
    expect(harness.messages[0]?.options).toEqual({
      triggerTurn: true,
      deliverAs: 'followUp',
    });

    fs.writeFileSync(
      path.join(project, '.impeccable', 'config.json'),
      JSON.stringify({ hook: { enabled: false } }),
    );
    expect(await harness.emit('tool_result', toolResult, ctx)).toBeUndefined();
  });

  test('context output drops the manual detector run once the design hook is on', async () => {
    const { project } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project);
    const contextResult = {
      toolName: 'bash',
      isError: false,
      input: { command: '.omp/skills/impeccable/scripts/impeccable context' },
      content: [
        {
          type: 'text',
          text: 'MANUAL_DETECTOR_REQUIRED: No automatic Impeccable design hook is active this session.',
        },
      ],
    };

    expect(
      await harness.emit('tool_result', contextResult, ctx),
    ).toBeUndefined();

    fs.mkdirSync(path.join(project, '.impeccable'));
    fs.writeFileSync(
      path.join(project, '.impeccable', 'config.local.json'),
      JSON.stringify({ hook: { consent: 'accepted' } }),
    );
    const result = await harness.emit<ToolTextResult>(
      'tool_result',
      contextResult,
      ctx,
    );

    expect(result?.content).toHaveLength(2);
    expect(result?.content[1]?.text).toMatch(
      /overrides the MANUAL_DETECTOR_REQUIRED line above.*design hook is active in this session.*Skip that manual detector run/,
    );
  });

  test('design hook events carry the session transcript path when there is one', async () => {
    const { project } = makeProject({
      hook: `
				let input = '';
				process.stdin.on('data', (chunk) => (input += chunk));
				process.stdin.on('end', () => {
					const event = JSON.parse(input);
					if (event.stop_hook_active) return;
					console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: \`\${event.hook_event_name}:\${event.session_id}:\${event.transcript_path ?? 'none'}\` } }));
				});
			`,
    });
    fs.mkdirSync(path.join(project, '.impeccable'));
    fs.writeFileSync(
      path.join(project, '.impeccable', 'config.local.json'),
      JSON.stringify({ hook: { consent: 'accepted' } }),
    );
    const transcript = path.join(project, 'session.jsonl');
    const edit = {
      toolName: 'write',
      isError: false,
      input: { path: 'src/a.css' },
      content: [{ type: 'text', text: 'written' }],
    };

    const withFile = loadExtension();
    const ctx = makeContext(project, { sessionFile: transcript });
    const edited = await withFile.emit<ToolTextResult>(
      'tool_result',
      edit,
      ctx,
    );
    await withFile.emit('agent_end', { messages: [] }, ctx);

    expect(edited?.content[1]?.text).toBe(
      `PostToolUse:test-session:${transcript}`,
    );
    expect(withFile.messages[0]?.message.content).toBe(
      `Stop:test-session:${transcript}`,
    );

    const withoutFile = loadExtension();
    const bare = await withoutFile.emit<ToolTextResult>(
      'tool_result',
      edit,
      makeContext(project),
    );
    expect(bare?.content[1]?.text).toBe('PostToolUse:test-session:none');
  });

  test('hooks on shows a note that supersedes the not-wired lines when the design hook is active', async () => {
    const { project } = makeProject({
      hooks: `console.log(${JSON.stringify(NOT_WIRED_OUTPUT)});\n`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project);

    await runCommand(harness, 'hooks on', ctx);
    expect(harness.messages.at(-1)?.message.content).toBe(NOT_WIRED_OUTPUT);

    fs.mkdirSync(path.join(project, '.impeccable'));
    fs.writeFileSync(
      path.join(project, '.impeccable', 'config.local.json'),
      JSON.stringify({ hook: { consent: 'accepted' } }),
    );
    await runCommand(harness, 'hooks on', ctx);

    const shown = String(harness.messages.at(-1)?.message.content);
    expect(shown.startsWith(NOT_WIRED_OUTPUT)).toBe(true);
    expect(shown).toMatch(
      /omp-impeccable runs this hook after edit and write tool calls and again when the agent finishes\. Ignore any "not wired" line above/,
    );
  });

  test('agent-run hooks output gets the not-wired note only while the design hook is active', async () => {
    const { project } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project);
    const hooksResult = (command: string, text = NOT_WIRED_OUTPUT) => ({
      toolName: 'bash',
      isError: false,
      input: { command },
      content: [{ type: 'text', text }],
    });
    const status = hooksResult(
      '.omp/skills/impeccable/scripts/impeccable hooks status',
    );

    expect(await harness.emit('tool_result', status, ctx)).toBeUndefined();

    fs.mkdirSync(path.join(project, '.impeccable'));
    fs.writeFileSync(
      path.join(project, '.impeccable', 'config.local.json'),
      JSON.stringify({ hook: { consent: 'accepted' } }),
    );
    const result = await harness.emit<ToolTextResult>(
      'tool_result',
      status,
      ctx,
    );

    expect(result?.content).toHaveLength(2);
    expect(result?.content[1]?.text).toMatch(
      /overrides any "No design harness is wired" or "not wired in any harness" line above.*design hook is active in this session.*design hook will run/,
    );
    // Neither a wired status nor an unrelated command that prints the same words is annotated.
    expect(
      await harness.emit(
        'tool_result',
        hooksResult(
          '.omp/skills/impeccable/scripts/impeccable hooks status',
          '  wiring .claude: wired',
        ),
        ctx,
      ),
    ).toBeUndefined();
    expect(
      await harness.emit('tool_result', hooksResult('cat notes.txt'), ctx),
    ).toBeUndefined();
  });

  test('agent commands are queued as hidden extension messages', async () => {
    const { project, skillRoot } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project, { idle: false });

    await runCommand(harness, 'audit src/App.tsx', ctx);

    const [entry] = harness.messages;
    expect(harness.messages).toHaveLength(1);
    expect(entry?.message.customType).toBe('impeccable-command');
    expect(entry?.message.display).toBe(false);
    expect(entry?.options?.deliverAs).toBe('followUp');
    expect(entry?.message.content).toMatch(
      /Handle this Impeccable invocation in OMP: \/impeccable audit src\/App\.tsx/,
    );
    expect(entry?.message.content).toMatch(new RegExp(escapeRegExp(skillRoot)));
    expect(entry?.message.content).toContain('not vendored extension files');
    expect(
      ctx.ui.statuses.some(
        (status) => status.value === '✦ impeccable audit queued',
      ),
    ).toBe(true);
    await harness.emit('session_shutdown', {}, ctx);
  });

  test('live status runs the installed script and summarizes JSON', async () => {
    const status: LiveStatus = {
      liveServer: { pid: 123 },
      activeSessions: [
        { phase: 'design_pass', sourceFile: 'src/App.tsx' },
        { phase: 'review', pageUrl: 'http://localhost:3000' },
      ],
    };
    const { project } = makeProject({
      'live-status': `console.log(${JSON.stringify(JSON.stringify(status))});\n`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project);

    await runCommand(harness, 'live status', ctx);

    expect(ctx.ui.notifications.at(-1)).toEqual({
      message:
        'Impeccable live: server running · design pass · src/App.tsx · +1 more',
      type: 'info',
    });
  });

  test('live mode sends browser events as hidden messages and does not foreground-poll', async () => {
    const event: LiveEvent = {
      type: 'generate',
      id: 'evt-1',
      prompt: 'Make the hero sharper',
    };
    const { project, skillRoot } = makeProject({
      live: 'console.log(JSON.stringify({ ok: true }));\n',
      'live-poll': `console.log(${JSON.stringify(JSON.stringify(event))});\n`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project, { idle: false });

    await runCommand(harness, 'live --delivery=followUp', ctx);
    expect(
      ctx.ui.statuses.some(
        (status) =>
          status.key === 'impeccable' && status.value === '✦ impeccable live',
      ),
    ).toBe(true);
    await waitFor(
      () =>
        harness.messages.some(
          (entry) => entry.message.customType === 'impeccable-live',
        ),
      'expected a hidden live event message',
    );
    await harness.emit('session_shutdown', {}, ctx);

    const liveMessage = harness.messages.find(
      (entry) => entry.message.customType === 'impeccable-live',
    );
    expect(liveMessage?.message.display).toBe(false);
    expect(liveMessage?.options?.deliverAs).toBe('followUp');
    expect(liveMessage?.message.content).toMatch(
      /Impeccable live event arrived from the background poll/,
    );
    expect(liveMessage?.message.content).toMatch(
      /call impeccable_live_reply with id "evt-1"/,
    );
    expect(liveMessage?.message.content).toContain(
      `Scripts: ${path.join(skillRoot, 'scripts')}`,
    );
    expect(
      ctx.ui.notifications.find((note) => /stop live or/.test(note.message)),
    ).toEqual({
      message: `Live has no page to open yet. The agent will find or start your dev server. ${stopHint}`,
      type: 'info',
    });
  });

  test.each([
    ['variant_mount_failed', 'impeccable_live_reply'],
    ['carbonize_cleanup', 'impeccable_live_complete'],
  ])('live %s events reach the agent with %s as the next step', async (type, tool) => {
    const event = { type, id: 'evt-2' };
    const { project } = makeProject({
      live: 'console.log(JSON.stringify({ ok: true }));\n',
      'live-poll': `console.log(${JSON.stringify(JSON.stringify(event))});\n`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project);

    await runCommand(harness, 'live', ctx);
    await waitFor(
      () =>
        harness.messages.some(
          (entry) => entry.message.customType === 'impeccable-live',
        ),
      `expected ${type} to reach the agent`,
    );
    await harness.emit('session_shutdown', {}, ctx);

    const liveMessage = harness.messages.find(
      (entry) => entry.message.customType === 'impeccable-live',
    );
    expect(liveMessage?.message.content).toContain(
      `call ${tool} with id "evt-2"`,
    );
  });

  test('live delivery can be set to aside', async () => {
    const event: LiveEvent = {
      type: 'generate',
      id: 'evt-1',
      prompt: 'Make the hero sharper',
    };
    const { project } = makeProject({
      live: 'console.log(JSON.stringify({ ok: true }));\n',
      'live-poll': `console.log(${JSON.stringify(JSON.stringify(event))});\n`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project, { idle: false });

    await runCommand(harness, 'live --delivery=aside', ctx);
    await waitFor(
      () =>
        harness.messages.some(
          (entry) => entry.message.customType === 'impeccable-live',
        ),
      'expected a hidden live event message',
    );
    await harness.emit('session_shutdown', {}, ctx);

    const liveMessage = harness.messages.find(
      (entry) => entry.message.customType === 'impeccable-live',
    );
    expect(liveMessage?.options?.deliverAs).toBe('aside');
  });

  test.each<[string, string[]]>([
    ['', ['--allow-missing-context', '--dev-url', '--auto-config']],
    [
      '--target apps/web',
      [
        '--allow-missing-context',
        '--dev-url',
        '--auto-config',
        '--target',
        'apps/web',
      ],
    ],
    [
      '--delivery=followUp --target=apps/web/index.html',
      [
        '--allow-missing-context',
        '--dev-url',
        '--auto-config',
        '--target=apps/web/index.html',
      ],
    ],
  ])('live boots with the three upstream flags and the target the user named (%j)', async (args, argv) => {
    const { project } = await startLiveWith(
      () => ({ ok: true, devUrl: pageUrl }),
      args,
    );

    expect(
      JSON.parse(fs.readFileSync(path.join(project, 'boot-argv.json'), 'utf8')),
    ).toEqual(argv);
  });

  test.skipIf(process.platform === 'win32')(
    'live opens the page in the user browser only when no page is connected and the user can open one',
    async () => {
      desktopSession();
      const opened = recordingBrowser();
      const attempt = async (
        clients: number | 'unreachable',
        options: { hasUI?: boolean } = {},
      ) => {
        const helper = await fakeLiveHelper(clients);
        const run = await startLiveWith(
          () => ({
            ok: true,
            serverPort: helper.port,
            serverToken: helper.token,
            devUrl: pageUrl,
          }),
          '',
          options,
        );
        return { ...run, helper };
      };

      const none = await attempt(0);
      await waitFor(() => opened().length > 0, 'the browser was not started');
      expect(none.helper.requests).toEqual(['/status?token=helper-token']);
      expect(none.ctx.ui.notifications).toEqual([
        {
          message: `Opened ${pageUrl} in your browser. ${firstMoveHint} ${stopHint}`,
          type: 'info',
        },
      ]);

      const connected = await attempt(1);
      const unseen = await attempt(0, { hasUI: false });
      vi.stubEnv('CI', 'true');
      const headless = await attempt(0);
      vi.stubEnv('CI', '');
      const down = await attempt('unreachable');

      expect(opened()).toEqual([pageUrl]);
      const told = `Open ${pageUrl} in your browser. ${firstMoveHint} ${stopHint}`;
      for (const run of [connected, headless, down])
        expect(run.ctx.ui.notifications).toEqual([
          { message: told, type: 'info' },
        ]);
      // Without a UI the one message goes out as a displayed message instead of a notification.
      expect(unseen.ctx.ui.notifications).toEqual([]);
      expect(unseen.harness.messages.map((entry) => entry.message)).toEqual([
        expect.objectContaining({ customType: 'impeccable', content: told }),
      ]);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'live tells the user to open the page themselves when their browser will not start',
    async () => {
      desktopSession();
      vi.stubEnv('IMPECCABLE_BROWSER', '/nonexistent/omp-impeccable-browser');
      const helper = await fakeLiveHelper(0);

      const { ctx } = await startLiveWith(() => ({
        ok: true,
        serverPort: helper.port,
        serverToken: helper.token,
        devUrl: pageUrl,
      }));

      expect(ctx.ui.notifications).toHaveLength(1);
      const note = ctx.ui.notifications[0];
      expect(note?.type).toBe('warning');
      expect(note?.message).toMatch(
        /^Could not open http:\/\/127\.0\.0\.1:5173\/ in your browser \(\/nonexistent\/omp-impeccable-browser: .*ENOENT.*\)\. Open it yourself\. First move/,
      );
      expect(note?.message).toMatch(
        / Say stop live or \/impeccable stop to stop\.$/,
      );
    },
  );

  test('live tells the user the page URL, with the first move only before the project has run Live', async () => {
    const sessions = (project: string) =>
      path.join(project, 'apps', 'web', '.impeccable', 'live');
    const boot = (project: string) => ({
      ok: true,
      devUrl: pageUrl,
      roots: { sessionRoot: sessions(project) },
    });
    const journal = (project: string, name?: string) => {
      fs.mkdirSync(path.join(sessions(project), 'sessions'), {
        recursive: true,
      });
      if (name)
        fs.writeFileSync(path.join(sessions(project), 'sessions', name), '{}');
    };

    const fresh = await startLiveWith(() => ({ ok: true, devUrl: pageUrl }));
    // The boot itself creates the empty sessions directory; only a journal file proves an earlier session.
    const booted = await startLiveWith(boot, '', {
      before: (project) => journal(project),
    });
    const used = await startLiveWith(boot, '', {
      before: (project) => journal(project, 'a1b2c3d4.jsonl'),
    });

    for (const run of [fresh, booted])
      expect(run.ctx.ui.notifications).toEqual([
        {
          message: `Open ${pageUrl} in your browser. ${firstMoveHint} ${stopHint}`,
          type: 'info',
        },
      ]);
    expect(used.ctx.ui.notifications).toEqual([
      { message: `Open ${pageUrl} in your browser. ${stopHint}`, type: 'info' },
    ]);
  });

  test('live reports the page, a created config, missing context and config drift in one notification, in that order', async () => {
    const messages = (run: { ctx: TestContext }) =>
      run.ctx.ui.notifications.map((note) => note.message);
    const page = `Open ${pageUrl} in your browser. ${firstMoveHint}`;

    const created = await startLiveWith((project) => ({
      ok: true,
      devUrl: pageUrl,
      configCreated: true,
      liveConfigPath: path.join(project, '.impeccable', 'live', 'config.json'),
      contextMissing: ['PRODUCT.md', 'DESIGN.md'],
      configDrift: {
        orphans: ['public/about.html'],
        orphanCount: 1,
        hint: driftHint,
      },
    }));
    const designOnly = await startLiveWith(() => ({
      ok: true,
      devUrl: pageUrl,
      contextMissing: ['DESIGN.md'],
    }));
    const complete = await startLiveWith(() => ({
      ok: true,
      devUrl: pageUrl,
      contextMissing: [],
    }));

    expect(messages(created)).toEqual([
      [
        page,
        `Added ${path.join('.impeccable', 'live', 'config.json')} to this project.`,
        'PRODUCT.md and DESIGN.md are missing. Live works without them. After the session, run /impeccable init and /impeccable document.',
        `${driftHint} Not covered: public/about.html.`,
        stopHint,
      ].join(' '),
    ]);
    expect(messages(designOnly)).toEqual([
      [
        page,
        'DESIGN.md is missing. Live works without it. After the session, run /impeccable document.',
        stopHint,
      ].join(' '),
    ]);
    expect(messages(complete)).toEqual([[page, stopHint].join(' ')]);
  });

  test.skipIf(process.platform === 'win32')(
    'live opens a static page by its file URL, the target page when the user named one',
    async () => {
      desktopSession();
      const opened = recordingBrowser();
      const helper = await fakeLiveHelper(0);
      const boot = (targetPath?: string) => (project: string) => ({
        ok: true,
        serverPort: helper.port,
        serverToken: helper.token,
        pageUrls: ['index.html', 'about.html'].map(
          (file) => pathToFileURL(path.join(project, file)).href,
        ),
        ...(targetPath ? { targetPath } : {}),
      });

      await startLiveWith(boot());
      await waitFor(() => opened().length === 1, 'the first page did not open');
      await startLiveWith(boot('about.html'));
      await waitFor(
        () => opened().length === 2,
        'the target page did not open',
      );

      expect(
        opened().map((url) => path.basename(new URL(url).pathname)),
      ).toEqual(['index.html', 'about.html']);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'live without a page URL keeps polling and asks the agent to find or start the dev server',
    async () => {
      desktopSession();
      const opened = recordingBrowser();
      const instructions =
        'No dev server answered. If one is already running on another port or HTTPS, use its URL; otherwise start `npm run dev` in the background, wait until it prints its URL, and run this boot again to get devUrl.';
      const { harness, ctx, project, skillRoot } = await startLiveWith(
        () => ({
          ok: true,
          devUrl: null,
          devCommand: 'npm run dev',
          _instructions: instructions,
        }),
        '--target apps/web',
      );
      await waitFor(
        () => fs.existsSync(path.join(project, 'poll-started')),
        'the extension did not start its poll',
      );

      expect(opened()).toEqual([]);
      expect(ctx.ui.notifications).toEqual([
        {
          message: `Live has no page to open yet. The agent will find or start your dev server. ${stopHint}`,
          type: 'info',
        },
      ]);
      expect(
        ctx.ui.statuses.some(
          (status) =>
            status.key === 'impeccable' && status.value === '✦ impeccable live',
        ),
      ).toBe(true);
      expect(harness.messages).toHaveLength(1);
      const [{ message, options }] = harness.messages;
      expect(message).toMatchObject({
        customType: 'impeccable-command',
        display: false,
      });
      expect(options).toEqual({ triggerTurn: true });
      const prompt = message.content;
      expect(prompt).toContain(`Boot instructions:\n${instructions}`);
      expect(prompt).toContain("The project's dev command is `npm run dev`.");
      expect(prompt).toContain(
        `boot again with \`${path.join(skillRoot, 'scripts', 'impeccable')} live --allow-missing-context --dev-url --auto-config --target apps/web\``,
      );
      expect(prompt).toContain(
        'tell the user its URL in one line, with the first move: click anything on the page, say what to change, press Go.',
      );
      expect(prompt).toMatch(/skip it\. omp-impeccable runs live-poll/);
      expect(prompt).toMatch(/Never run live-poll yourself/);
    },
  );

  test('a free-form live request goes to the agent with the user delivery, not to a guessed boot', async () => {
    const event = { type: 'steer', id: 'evt-9', message: 'tighten it' };
    const { harness, ctx, project, skillRoot } = await startLiveWith(
      () => ({ ok: true, devUrl: pageUrl }),
      'the pricing page --target apps/web --delivery=followUp',
      {
        idle: false,
        poll: `console.log(${JSON.stringify(JSON.stringify(event))});\n`,
      },
    );

    expect(fs.existsSync(path.join(project, 'boot-argv.json'))).toBe(false);
    expect(harness.messages).toHaveLength(1);
    const [{ message, options }] = harness.messages;
    expect(message.display).toBe(false);
    expect(options).toEqual({ triggerTurn: true, deliverAs: 'followUp' });
    expect(message.content).toMatch(
      /^Handle this Impeccable invocation in OMP: \/impeccable live the pricing page --target apps\/web\n/,
    );
    expect(message.content).toContain(path.join(skillRoot, 'SKILL.md'));
    expect(message.content).toContain(
      `${path.join(skillRoot, 'scripts', 'impeccable')} live --allow-missing-context --dev-url --auto-config`,
    );
    expect(message.content).toMatch(/Never run live-poll yourself/);

    // The poll the agent asks for starts in the background and keeps the delivery the user chose.
    const blocked = await harness.emit<ToolCallResult>(
      'tool_call',
      {
        toolName: 'bash',
        input: {
          command: `${path.join(skillRoot, 'scripts', 'impeccable')} live-poll`,
        },
      },
      ctx,
    );
    expect(blocked?.block).toBe(true);
    await waitFor(
      () =>
        harness.messages.some(
          (entry) => entry.message.customType === 'impeccable-live',
        ),
      'expected the live event to reach the agent',
    );
    expect(
      harness.messages.find(
        (entry) => entry.message.customType === 'impeccable-live',
      )?.options?.deliverAs,
    ).toBe('followUp');
  });

  test.each<[string, number, Record<string, unknown>]>([
    [
      'config_missing',
      0,
      {
        ok: false,
        error: 'config_missing',
        path: '/app/.impeccable/live/config.json',
      },
    ],
    ['no_page', 1, { ok: false, error: 'no_page', path: '/app' }],
    [
      'target_selection_required',
      0,
      {
        ok: false,
        error: 'target_selection_required',
        targetCandidates: [{ name: 'web', path: 'apps/web' }],
        hint: 'Ask the user which app Impeccable should use.',
      },
    ],
  ])('a %s live boot goes to the agent with its output', async (error, exitCode, refusal) => {
    const { harness, ctx, skillRoot } = await startLiveWith(() => refusal, '', {
      exitCode,
    });

    expect(
      harness.messages.map(({ message }) => [
        message.customType,
        message.display,
      ]),
    ).toEqual([
      ['impeccable', true],
      ['impeccable-command', false],
    ]);
    const [shown, handed] = harness.messages.map(
      ({ message }) => message.content,
    );
    expect(shown).toMatch(/^Impeccable live needs setup:/);
    expect(shown).toContain(`"error": "${error}"`);
    expect(handed).toContain(
      'Handle this Impeccable invocation in OMP: /impeccable live\n',
    );
    expect(handed).toContain(
      `\`\`\`json\n${JSON.stringify(refusal, null, 2)}\n\`\`\``,
    );
    expect(handed).toContain(
      `${path.join(skillRoot, 'scripts', 'impeccable')} live --allow-missing-context --dev-url --auto-config\``,
    );
    // Nothing is running yet: no live indicator.
    expect(ctx.ui.statuses.some((status) => status.key === 'impeccable')).toBe(
      false,
    );
  });

  test('a live boot that crashed is shown to the user and not handed to the agent', async () => {
    const { harness } = await startLiveWith(() => ({}), '', {
      live: "console.error('engine missing');\nprocess.exitCode = 1;\n",
    });

    expect(harness.messages.map(({ message }) => message)).toEqual([
      expect.objectContaining({
        customType: 'impeccable',
        display: true,
        content: 'Impeccable live failed:\n\nengine missing\n',
      }),
    ]);
  });

  test('quitting while the agent handles a live event asks first', async () => {
    const event: LiveEvent = {
      type: 'generate',
      id: 'evt-1',
      prompt: 'Make the hero sharper',
    };
    const { project } = makeProject({
      live: 'console.log(JSON.stringify({ ok: true }));\n',
      'live-poll': `console.log(${JSON.stringify(JSON.stringify(event))});\n`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project);
    const quit = { signal: new AbortController().signal };

    expect(await harness.emit('session_before_shutdown', quit, ctx)).toBe(
      undefined,
    );
    expect(ctx.ui.confirms).toEqual([]);

    await runCommand(harness, 'live', ctx);
    await waitFor(
      () =>
        harness.messages.some(
          (entry) => entry.message.customType === 'impeccable-live',
        ),
      'expected a hidden live event message',
    );

    ctx.ui.confirmAnswer = false;
    expect(await harness.emit('session_before_shutdown', quit, ctx)).toEqual({
      cancel: true,
    });
    expect(ctx.ui.confirms.at(-1)?.message).toMatch(/live generate event/);
    ctx.ui.confirmAnswer = true;
    expect(await harness.emit('session_before_shutdown', quit, ctx)).toBe(
      undefined,
    );
    await harness.emit('session_shutdown', {}, ctx);
  });

  test('session shutdown stops live server and ignores killed polls', async () => {
    const stopArgs = path.join(
      os.tmpdir(),
      `omp-impeccable-stop-${process.pid}.json`,
    );
    onTestFinished(() => fs.rmSync(stopArgs, { force: true }));
    const { project } = makeProject({
      live: 'console.log(JSON.stringify({ ok: true, devUrl: "http://127.0.0.1:5173/" }));\n',
      'live-poll': `setTimeout(() => console.log(JSON.stringify({ type: 'generate', id: 'late' })), 5000);\n`,
      'live-server': `
        import fs from 'node:fs';
        if (process.argv.includes('stop')) fs.writeFileSync(${JSON.stringify(stopArgs)}, JSON.stringify(process.argv.slice(2)));
      `,
    });
    const harness = loadExtension();
    const ctx = makeContext(project);

    await runCommand(harness, 'live', ctx);
    await harness.emit('session_shutdown', {}, ctx);
    await delay(50);

    expect(JSON.parse(fs.readFileSync(stopArgs, 'utf8'))).toEqual(['stop']);
    expect(harness.messages).toEqual([]);
    expect(
      ctx.ui.notifications.some((note) => /poll failed/.test(note.message)),
    ).toBe(false);
  });

  test('live poll handler failures do not escape as uncaught exceptions', async () => {
    const event = { type: 'accepted', id: 'evt-1' };
    const { project } = makeProject({
      live: 'console.log(JSON.stringify({ ok: true }));\n',
      'live-poll': `console.log(${JSON.stringify(JSON.stringify(event))});\n`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project, {
      throwOnNotify: (message) => message === 'Impeccable live: accepted',
    });

    await runCommand(harness, 'live', ctx);
    await waitFor(
      () =>
        ctx.ui.statuses.some(
          (status) =>
            status.key === 'impeccable' &&
            status.value === '✦ impeccable error',
        ),
      'expected the live indicator to show the handler failure',
    );
    await harness.emit('session_shutdown', {}, ctx);

    expect(ctx.ui.notifications.at(-1)).toEqual({
      message:
        'Impeccable live error: stale ctx; run /impeccable live to resume.',
      type: 'error',
    });
  });

  test('foreground live-poll bash calls are blocked', async () => {
    const harness = loadExtension();
    const ctx = makeContext(root);

    const blocked = await harness.emit<ToolCallResult>(
      'tool_call',
      {
        toolName: 'bash',
        input: {
          command: '.omp/skills/impeccable/scripts/impeccable live-poll',
        },
      },
      ctx,
    );
    const reply = await harness.emit<ToolCallResult>(
      'tool_call',
      {
        toolName: 'bash',
        input: {
          command:
            '.omp/skills/impeccable/scripts/impeccable live-poll --reply evt done',
        },
      },
      ctx,
    );

    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(
      /managed by the omp-impeccable extension in the background/,
    );
    expect(reply).toBeUndefined();
  });

  test.skipIf(process.platform === 'win32')(
    'build-phase bash calls carry the session id the Stop hook checks',
    async () => {
      const harness = loadExtension();
      const ctx = makeContext(root);
      const call = (command: string) =>
        harness.emit<ToolCallResult>(
          'tool_call',
          { toolName: 'bash', input: { command, timeout: 60 } },
          ctx,
        );
      const start =
        '.omp/skills/impeccable/scripts/impeccable build-phase start --artifact index.html';

      const quoted =
        "'/tmp/p/.omp/skills/impeccable/scripts/impeccable' build-phase advance";

      expect(await call(start)).toMatchObject({
        input: {
          command: `export IMPECCABLE_SESSION_ID='test-session'\n${start}`,
          timeout: 60,
        },
        additionalContext: expect.stringMatching(/expected: do not remove/),
      });
      expect((await call(quoted))?.input?.command).toBe(
        `export IMPECCABLE_SESSION_ID='test-session'\n${quoted}`,
      );
      expect(await call(`${start} --session-id other-session`)).toBeUndefined();
      expect(
        await call('echo build-phase=$IMPECCABLE_SESSION_ID'),
      ).toBeUndefined();
      expect(
        await call('.omp/skills/impeccable/scripts/impeccable detect --json'),
      ).toBeUndefined();
    },
  );

  test('a session the user can see exports IMPECCABLE_QUESTION_FORCE for its shells', async () => {
    desktopSession();
    vi.stubEnv('IMPECCABLE_QUESTION_FORCE', '');
    const harness = loadExtension();
    const start = (ctx = makeContext(root)) =>
      harness.emit('session_start', {}, ctx);

    await start();
    expect(process.env.IMPECCABLE_QUESTION_FORCE).toBe('1');
    // The page still serves through the unchanged command.
    const review =
      '.omp/skills/impeccable/scripts/impeccable component-review serve --session abc';
    expect(
      await harness.emit(
        'tool_call',
        { toolName: 'bash', input: { command: review } },
        makeContext(root),
      ),
    ).toBeUndefined();
    // A later session with no UI withdraws the value the extension set.
    await start(makeContext(root, { hasUI: false }));
    expect(process.env.IMPECCABLE_QUESTION_FORCE).toBeUndefined();
    // omp's own process in CI, or over SSH with no display, cannot open the page.
    vi.stubEnv('CI', 'true');
    await start();
    expect(process.env.IMPECCABLE_QUESTION_FORCE).toBeUndefined();
    vi.stubEnv('CI', '');
    vi.stubEnv('SSH_CONNECTION', '10.0.0.2 50000 10.0.0.1 22');
    vi.stubEnv('DISPLAY', '');
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-1');
    await start();
    expect(process.env.IMPECCABLE_QUESTION_FORCE).toBeUndefined();
    // A value the user set is theirs: a session with no UI leaves it alone.
    vi.stubEnv('IMPECCABLE_QUESTION_FORCE', '1');
    const own = loadExtension();
    await own.emit('session_start', {}, makeContext(root, { hasUI: false }));
    expect(process.env.IMPECCABLE_QUESTION_FORCE).toBe('1');
  });

  test.skipIf(process.platform === 'win32')(
    'a served page opens once in the user browser and the tool result says so',
    async () => {
      desktopSession();
      const opened = recordingBrowser();
      const harness = loadExtension();
      const ctx = makeContext(root);
      const launcher = '.omp/skills/impeccable/scripts/impeccable';
      const review = `${launcher} component-review serve --session abc`;
      const reviewOutput =
        'COMPONENT REVIEW: {"url":"http://127.0.0.1:41465/","pid":7}\n';
      const update = (command: string, text: string) =>
        harness.emit(
          'tool_execution_update',
          {
            toolName: 'bash',
            args: { command },
            partialResult: { content: [{ type: 'text', text }] },
          },
          ctx,
        );
      const result = (command: string, text: string, context = ctx) =>
        harness.emit<{ content: Array<{ type: string; text: string }> }>(
          'tool_result',
          {
            toolName: 'bash',
            isError: false,
            input: { command },
            content: [{ type: 'text', text }],
          },
          context,
        );

      // The review server keeps running, so the URL arrives in a streamed update.
      await update(review, reviewOutput);
      await update(review, `${reviewOutput}COMPONENT REVIEW: submitted\n`);
      const final = await result(
        review,
        `${reviewOutput}COMPONENT REVIEW: submitted\n`,
      );
      await waitFor(() => opened().length > 0, 'the browser was not started');
      expect(final?.content.at(-1)?.text).toMatch(
        /opened http:\/\/127\.0\.0\.1:41465\/ in the user's browser\. Do not open it again/,
      );
      expect(ctx.ui.notifications.at(-1)).toEqual({
        message:
          'Opened the Impeccable page in your browser: http://127.0.0.1:41465/',
        type: 'info',
      });

      await result(
        `${launcher} serve-question --start --payload q.json`,
        'QUESTION URL: http://127.0.0.1:5000/\nQUESTION KEY: k\n',
      );
      // A blocking serve-question and --start --open open the browser themselves.
      await result(
        `${launcher} serve-question --payload q.json`,
        'QUESTION URL: http://127.0.0.1:5001/\n',
      );
      await result(
        `${launcher} serve-question --start --open --payload q.json`,
        'QUESTION URL: http://127.0.0.1:5002/\n',
      );
      // Only Impeccable's loopback servers, and only for a session with a UI.
      expect(
        await result(
          review,
          'COMPONENT REVIEW: {"url":"https://example.com/"}\n',
        ),
      ).toBeUndefined();
      await result(
        review,
        'COMPONENT REVIEW: {"url":"http://127.0.0.1:6000/"}\n',
        makeContext(root, { hasUI: false }),
      );
      await waitFor(
        () => opened().length > 1,
        'the decision page was not opened',
      );
      await delay(100);
      expect(opened()).toEqual([
        'http://127.0.0.1:41465/',
        'http://127.0.0.1:5000/',
      ]);
    },
  );

  test('the browser follows upstream preference order', () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omp-impeccable-browser-'),
    );
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const url = 'http://127.0.0.1:1/';
    const pick = (
      env: NodeJS.ProcessEnv,
      platform: NodeJS.Platform = 'linux',
    ) => browserCommand(url, dir, env, platform);

    expect(pick({})).toEqual(['xdg-open', [url]]);
    expect(pick({}, 'darwin')).toEqual(['open', [url]]);
    expect(pick({}, 'win32')).toEqual(['cmd', ['/c', 'start', '', url]]);
    expect(pick({ BROWSER: 'firefox' })).toEqual(['firefox', [url]]);
    fs.mkdirSync(path.join(dir, '.impeccable'));
    fs.writeFileSync(
      path.join(dir, '.impeccable/config.json'),
      '{"browser":"Safari"}',
    );
    expect(pick({ BROWSER: 'firefox' }, 'darwin')).toEqual([
      'open',
      ['-a', 'Safari', url],
    ]);
    fs.writeFileSync(
      path.join(dir, '.impeccable/config.local.json'),
      '{"browser":"chromium"}',
    );
    expect(pick({ BROWSER: 'firefox' })).toEqual(['chromium', [url]]);
    expect(
      pick(
        { IMPECCABLE_BROWSER: '/opt/b/browser', BROWSER: 'firefox' },
        'darwin',
      ),
    ).toEqual(['/opt/b/browser', [url]]);
  });

  test('reply and complete tools call the skill launcher with the expected verbs and args', async () => {
    const replyArgs = path.join(
      os.tmpdir(),
      `omp-impeccable-reply-${process.pid}.json`,
    );
    const completeArgs = path.join(
      os.tmpdir(),
      `omp-impeccable-complete-${process.pid}.json`,
    );
    onTestFinished(() => {
      fs.rmSync(replyArgs, { force: true });
      fs.rmSync(completeArgs, { force: true });
    });
    const { project } = makeProject({
      'live-poll': `
				import fs from 'node:fs';
				if (process.argv.includes('--reply')) {
					fs.writeFileSync(${JSON.stringify(replyArgs)}, JSON.stringify(process.argv.slice(2)));
				} else {
					console.log(JSON.stringify({ type: 'exit' }));
				}
			`,
      'live-complete': `
				import fs from 'node:fs';
				fs.writeFileSync(${JSON.stringify(completeArgs)}, JSON.stringify(process.argv.slice(2)));
			`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project);

    const reply = await executeTool(
      harness,
      'impeccable_live_reply',
      'reply-call',
      {
        id: 'evt-1',
        status: 'done',
        file: 'src/App.tsx',
        data: { ok: true },
        message: 'Looks good',
      },
      ctx,
    );
    const complete = await executeTool(
      harness,
      'impeccable_live_complete',
      'complete-call',
      {
        id: 'session-1',
        discarded: true,
      },
      ctx,
    );
    await harness.emit('session_shutdown', {}, ctx);

    expect(reply.content[0]?.text).toMatch(/resumed polling/);
    expect(complete.content[0]?.text).toMatch(/resumed polling/);
    expect(JSON.parse(fs.readFileSync(replyArgs, 'utf8'))).toEqual([
      '--reply',
      'evt-1',
      'done',
      '--file',
      'src/App.tsx',
      '--data',
      '{"ok":true}',
      'Looks good',
    ]);
    expect(JSON.parse(fs.readFileSync(completeArgs, 'utf8'))).toEqual([
      '--id',
      'session-1',
      '--discarded',
    ]);
  });

  test('summarizeLiveStatus handles empty and non-JSON output', () => {
    expect(summarizeLiveStatus('')).toBe('No Impeccable live status.');
    expect(summarizeLiveStatus('plain text')).toBe('plain text');
  });

  test('subagents denied write tools in Claude stay read-only in OMP', () => {
    const converted = ompAgent(
      [
        '---',
        'name: impeccable-finish-reviewer',
        'description: Reviews a finished build.',
        'disallowedTools: Write, Edit, NotebookEdit',
        'model: inherit',
        'effort: high',
        '---',
        'Read `.claude/skills/impeccable/reference/craft-floor.md`.',
        '',
      ].join('\n'),
    );
    const frontmatter = converted.split('\n---\n')[0];
    const tools = /^tools: (.*)$/m
      .exec(frontmatter)?.[1]
      .split(', ')
      .filter(Boolean);
    expect(tools).toContain('read');
    expect(tools).toContain('bash');
    expect(tools).not.toContain('write');
    expect(tools).not.toContain('edit');
    expect(tools).not.toContain('ast_edit');
    expect(frontmatter).not.toMatch(/disallowedTools|^model:/m);
    expect(frontmatter).toMatch(/^thinkingLevel: high$/m);
    expect(converted).toContain('.omp/skills/impeccable/reference');
  });
});

type Completion = {
  value: string;
  description?: string;
};

type EventHandler = (
  event: unknown,
  ctx: TestContext,
) => unknown | Promise<unknown>;

type Harness = {
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, TestCommand>;
  tools: Map<string, ToolDefinition>;
  messages: SentMessage[];
  emit<T = unknown>(
    name: string,
    event?: unknown,
    ctx?: TestContext,
  ): Promise<T | undefined>;
};

type LiveEvent = {
  type: string;
  id: string;
  prompt: string;
};

type LiveStatus = {
  liveServer: { pid: number };
  activeSessions: Array<{
    phase: string;
    sourceFile?: string;
    pageUrl?: string;
  }>;
};

type PackageJson = {
  omp: { extensions: string[] };
  dependencies: Record<string, string>;
  files: string[];
};

type SlashCommandInfo = ReturnType<ExtensionAPI['getCommands']>[number];

type ProjectFixture = {
  project: string;
  skillRoot: string;
};

type ResourcesDiscoverResult = {
  skillPaths: string[];
};

type SentMessage = {
  message: Exclude<Parameters<ExtensionAPI['sendMessage']>[0], string>;
  options: Parameters<ExtensionAPI['sendMessage']>[1];
};

type TestCommand = Omit<
  RegisteredCommand,
  'name' | 'sourceInfo' | 'handler' | 'getArgumentCompletions'
> & {
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => Completion[] | null | Promise<Completion[] | null>;
  handler: (args: string, ctx: TestContext) => Promise<void> | void;
};

type TestContext = {
  cwd: string;
  hasUI: boolean;
  ui: TestUI;
  isIdle: () => boolean;
  signal: AbortSignal | undefined;
  setTimeout: (fn: () => void, ms?: number) => NodeJS.Timeout;
  clearTimer: (timer: NodeJS.Timeout) => void;
  sessionManager: {
    getSessionId: () => string;
    getSessionFile: () => string | undefined;
  };
};

type TestUI = {
  notifications: Array<{
    message: string;
    type?: 'info' | 'warning' | 'error';
  }>;
  statuses: Array<{ key: string; value: string | undefined }>;
  confirms: Array<{ title: string; message: string }>;
  confirmAnswer: boolean;
  theme: { fg: (color: string, text: string) => string };
  notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
  setStatus: (key: string, value: string | undefined) => void;
  confirm: (title: string, message: string) => Promise<boolean>;
};

type ToolCallResult = {
  block?: boolean;
  reason?: string;
  input?: Record<string, unknown>;
  additionalContext?: string;
};

type ToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

async function argumentCompletions(
  harness: Harness,
  prefix: string,
): Promise<Completion[]> {
  return (
    (await impeccableCommand(harness).getArgumentCompletions?.(prefix)) ?? []
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function executeTool(
  harness: Harness,
  name: string,
  toolCallId: string,
  params: unknown,
  ctx: TestContext,
): Promise<ToolTextResult> {
  const found = harness.tools.get(name);
  if (!found) throw new Error(`${name} tool was not registered`);
  return found.execute(
    toolCallId,
    params,
    undefined,
    undefined,
    ctx as unknown as ExtensionContext,
  ) as Promise<ToolTextResult>;
}

function impeccableCommand(harness: Harness): TestCommand {
  const command = harness.commands.get('impeccable');
  if (!command) throw new Error('impeccable command was not registered');
  return command;
}

function loadExtension(
  extraCommands: SlashCommandInfo[] = [],
  { getCommandsUnavailable = false }: { getCommandsUnavailable?: boolean } = {},
): Harness {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, TestCommand>();
  const tools = new Map<string, ToolDefinition>();
  const messages: SentMessage[] = [];
  const schema = () => ({
    describe() {
      return this;
    },
    optional() {
      return this;
    },
  });
  const z = {
    object: (shape: unknown) => ({ shape }),
    string: schema,
    enum: schema,
    boolean: schema,
    any: schema,
  };
  const api = {
    zod: { z },
    on(name: string, handler: EventHandler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name: string, command: TestCommand) {
      commands.set(name, command);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    sendMessage(
      message: SentMessage['message'],
      options: SentMessage['options'],
    ) {
      messages.push({ message, options });
    },
    getCommands() {
      if (getCommandsUnavailable) throw new Error('getCommands unavailable');
      return [
        ...[...commands.entries()].map(([name, command]) => ({
          name,
          description: command.description,
          source: 'extension' as const,
        })),
        ...extraCommands,
      ];
    },
  };
  impeccableExtension(api as unknown as ExtensionAPI);

  return {
    handlers,
    commands,
    tools,
    messages,
    async emit<T = unknown>(
      name: string,
      event: unknown = {},
      ctx: TestContext = makeContext(root),
    ) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        const value = await handler(event, ctx);
        if (value !== undefined) result = value;
      }
      return result as T | undefined;
    },
  };
}

function makeContext(
  cwd: string,
  {
    idle = true,
    hasUI = true,
    throwOnNotify,
    sessionFile,
  }: {
    idle?: boolean;
    hasUI?: boolean;
    throwOnNotify?: (message: string) => boolean;
    sessionFile?: string;
  } = {},
): TestContext {
  const notifications: TestUI['notifications'] = [];
  const statuses: TestUI['statuses'] = [];
  const ui: TestUI = {
    notifications,
    statuses,
    confirms: [],
    confirmAnswer: true,
    theme: { fg: (_color, text) => text },
    notify(message, type) {
      notifications.push({ message, type });
      if (throwOnNotify?.(message)) throw new Error('stale ctx');
    },
    setStatus(key, value) {
      statuses.push({ key, value });
    },
    async confirm(title, message) {
      this.confirms.push({ title, message });
      return this.confirmAnswer;
    },
  };
  return {
    cwd,
    hasUI,
    ui,
    isIdle: () => idle,
    signal: undefined,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer),
    sessionManager: {
      getSessionId: () => 'test-session',
      getSessionFile: () => sessionFile,
    },
  };
}

// Fake skill: scripts/impeccable dispatches `<verb> ...args` to scripts/verbs/<verb>.mjs.
function makeProject(verbs: Record<string, string> = {}): ProjectFixture {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-impeccable-'));
  const skillRoot = path.join(project, '.omp', 'skills', 'impeccable');
  const scripts = path.join(skillRoot, 'scripts');
  fs.mkdirSync(path.join(project, '.git'));
  fs.mkdirSync(path.join(scripts, 'verbs'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# fake impeccable\n');
  fs.writeFileSync(
    path.join(scripts, 'impeccable'),
    `#!/bin/sh\nverb=$1\nshift\nexec "${process.execPath}" "$(dirname "$0")/verbs/$verb.mjs" "$@"\n`,
    { mode: 0o755 },
  );
  for (const [verb, source] of Object.entries(verbs)) {
    fs.writeFileSync(path.join(scripts, 'verbs', `${verb}.mjs`), source);
  }
  onTestFinished(() => fs.rmSync(project, { recursive: true, force: true }));
  return { project, skillRoot };
}

const NOT_WIRED_OUTPUT = [
  'Design hook enabled for this project.',
  'No design harness is wired. Install the skill for your harness, then run impeccable hooks on.',
  '  wiring .claude: not wired (missing or stale entries)',
  'enabled in config, not wired in any harness; repair with: impeccable hooks on',
].join('\n');

function readPackageJson(): PackageJson {
  return JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ) as PackageJson;
}

async function runCommand(
  harness: Harness,
  args: string,
  ctx: TestContext,
): Promise<void> {
  await impeccableCommand(harness).handler(args, ctx);
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(message);
}

// OMP's own process on a local desktop: no CI, a display. The shell that runs the tests may set CI=true.
function desktopSession() {
  vi.stubEnv('CI', '');
  vi.stubEnv('IMPECCABLE_QUESTION_DISABLED', '');
  vi.stubEnv('SSH_CONNECTION', '');
  vi.stubEnv('DISPLAY', ':0');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
}

// IMPECCABLE_BROWSER pointed at a script that records each URL it is started with.
function recordingBrowser(): () => string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-impeccable-open-'));
  const log = path.join(dir, 'opened');
  const script = path.join(dir, 'browser');
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\n`, {
    mode: 0o755,
  });
  vi.stubEnv('IMPECCABLE_BROWSER', script);
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return () =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
}

const pageUrl = 'http://127.0.0.1:5173/';

const firstMoveHint =
  'First move: click anything on the page, say what to change, press Go. Pick is the crosshair in the bar at the bottom.';

const stopHint = 'Say stop live or /impeccable stop to stop.';

// The hint the boot's own `configDrift` carries.
const driftHint =
  '1 HTML file(s) exist but aren\'t in config.files. Consider adding them, or use a glob pattern like "public/**/*.html".';

// A `live-poll` that marks that the extension started it, then waits like a poll with no events.
const idlePoll = `
  import fs from 'node:fs';
  fs.writeFileSync('poll-started', '');
  setInterval(() => {}, 1000);
`;

// A `live` verb that records its argv in the project and prints the boot output; a refusal can exit non-zero.
function liveBoot(boot: unknown, exitCode = 0): string {
  return `
    import fs from 'node:fs';
    fs.writeFileSync('boot-argv.json', JSON.stringify(process.argv.slice(2)));
    console.log(${JSON.stringify(JSON.stringify(boot))});
    process.exitCode = ${exitCode};
  `;
}

// Runs `/impeccable live <args>` against a fake boot and an idle poll, and ends the session when the test does.
async function startLiveWith(
  boot: (project: string) => unknown,
  args = '',
  {
    exitCode = 0,
    hasUI = true,
    idle = true,
    live,
    poll = idlePoll,
    before,
  }: {
    exitCode?: number;
    hasUI?: boolean;
    idle?: boolean;
    live?: string;
    poll?: string;
    before?: (project: string) => void;
  } = {},
) {
  const { project, skillRoot } = makeProject();
  const verbs = path.join(skillRoot, 'scripts', 'verbs');
  fs.writeFileSync(
    path.join(verbs, 'live.mjs'),
    live ?? liveBoot(boot(project), exitCode),
  );
  fs.writeFileSync(path.join(verbs, 'live-poll.mjs'), poll);
  before?.(project);
  const harness = loadExtension();
  const ctx = makeContext(project, { hasUI, idle });
  onTestFinished(async () => {
    await harness.emit('session_shutdown', {}, ctx);
  });
  await runCommand(harness, `live ${args}`.trimEnd(), ctx);
  return { harness, ctx, project, skillRoot };
}

// Stands in for the Live helper's `GET /status`: reports `connectedClients` to the right token and refuses any other.
// 'unreachable' hands back a port nothing listens on.
async function fakeLiveHelper(connectedClients: number | 'unreachable') {
  const token = 'helper-token';
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    const authorized =
      new URL(req.url ?? '/', 'http://helper').searchParams.get('token') ===
      token;
    res.writeHead(authorized ? 200 : 401, {
      'content-type': 'application/json',
    });
    res.end(
      JSON.stringify(
        authorized
          ? { status: 'ok', connectedClients }
          : { error: 'Unauthorized' },
      ),
    );
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  const close = () => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    server.closeAllConnections();
    return closed.promise;
  };
  if (connectedClients === 'unreachable') await close();
  else onTestFinished(close);
  return { port, token, requests };
}
