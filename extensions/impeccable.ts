import { type ChildProcessByStdio, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import {
  agentCommands,
  extensionCommandDescriptions,
  fallbackAgentCommandDescriptions,
  helpText,
} from './ui-helpers.ts';

export default function impeccableExtension(pi: ExtensionAPI) {
  const { z } = pi.zod;
  let ctxRef: ExtensionContext | undefined;
  const live: LiveState = { active: false, delivery: 'steer' };
  const pinnedCommandNames = new Set<string>();
  let designHookContinuing = false;
  const servedPages = new Map<string, Promise<string>>();
  let exportedBrowserForce = false;

  pi.on('resources_discover', (event) => {
    const skillRoot = locateSkill(event.cwd);
    return skillRoot ? { skillPaths: [skillRoot] } : undefined;
  });

  pi.on('session_start', (_event, ctx) => {
    ctxRef = ctx;
    exportedBrowserForce = exportBrowserForce(
      userCanOpenBrowser(ctx.hasUI),
      exportedBrowserForce,
    );
    registerPinnedCommands(pi, pinnedCommandNames, ctx.cwd);
    if (live.active) startIndicator(live, ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    const wasActive = live.active || !!live.poll;
    const cwd = live.cwd ?? ctx.cwd;
    const skillRoot = live.skillRoot ?? locateSkill(cwd);

    live.active = false;
    live.pausedFor = undefined;
    killPoll(live);
    clearTransientStatus(ctx);
    stopIndicator(live, ctx);
    ctxRef = undefined;

    if (wasActive && skillRoot) {
      await runLauncher(
        skillRoot,
        'live-server',
        ['stop'],
        cwd,
        undefined,
        30_000,
      );
    }
  });

  // Quitting while the agent handles a live event can leave its unfinished edits in source files.
  pi.on('session_before_shutdown', async (event, ctx) => {
    const pending = pendingLiveEvent(live);
    if (!pending || !ctx.hasUI) return;
    const quit = await ctx.ui.confirm(
      'Quit during an Impeccable live event?',
      `The agent is still handling a live ${pending} event. Quitting now can leave its unfinished edits in your source files.`,
      { signal: event.signal },
    );
    return quit ? undefined : { cancel: true };
  });

  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') return;
    if (
      !/^\s*(stop|exit)\s+(impeccable\s+)?live(\s+mode)?\s*$/i.test(event.text)
    )
      return;
    await stopLive(pi, live, ctx);
    return { handled: true };
  });

  pi.on('tool_call', (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const { command } = event.input;
    if (typeof command !== 'string') return;
    if (!isForegroundLivePoll(command)) {
      const identified = withBuildSessionIdentity(
        command,
        ctx.sessionManager.getSessionId(),
      );
      if (!identified) return undefined;
      // The model sees the revised command; without a reason it reruns the call to drop the export.
      return {
        input: { ...event.input, command: identified },
        additionalContext:
          "The omp-impeccable extension, not you, prefixed that build-phase command with an IMPECCABLE_SESSION_ID export holding this OMP session's id, so the build records this session as its owner. This is expected: do not remove the export or rerun the command because of it.",
      };
    }

    const skillRoot = locateSkill(ctx.cwd);
    if (skillRoot) {
      live.active = true;
      live.cwd = ctx.cwd;
      live.skillRoot = skillRoot;
      startPoll(pi, live, ctxRef ?? ctx);
      ctx.ui.notify('Moved Impeccable live polling to the background.', 'info');
    }

    return {
      block: true,
      reason:
        'Impeccable live polling is managed by the omp-impeccable extension in the background. Do not run impeccable live-poll as a foreground bash tool.',
    };
  });

  // A served page prints its URL at once, while `component-review serve` keeps running until the user submits.
  pi.on('tool_execution_update', async (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const { command } = (event.args ?? {}) as { command?: unknown };
    const result = event.partialResult as { content?: unknown } | undefined;
    await openServedPage(servedPages, command, textOf(result?.content), ctx);
  });

  // Upstream's design hook, driven from OMP tool and agent events instead of a harness manifest.
  pi.on('tool_result', async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName === 'bash') {
      const opened = await openServedPage(
        servedPages,
        event.input.command,
        textOf(event.content),
        ctx,
      );
      const content: ToolResultEvent['content'] = opened
        ? [...event.content, { type: 'text', text: opened }]
        : event.content;
      return (
        withManualDetectorOverride(content, ctx.cwd) ??
        withHooksNotWiredOverride(content, event.input.command, ctx.cwd) ??
        (opened ? { content } : undefined)
      );
    }
    if (event.toolName !== 'edit' && event.toolName !== 'write') return;
    const skillRoot = designHookActive(ctx.cwd);
    if (!skillRoot) return;
    const notes: string[] = [];
    for (const file of changedFiles(ctx.cwd, event.input, event.details)) {
      const note = await runDesignHook(
        skillRoot,
        ctx,
        {
          hook_event_name: 'PostToolUse',
          tool_name: event.toolName === 'edit' ? 'Edit' : 'Write',
          tool_input: { file_path: file },
        },
        EDIT_HOOK_TIMEOUT_MS,
      );
      if (note) notes.push(note);
    }
    if (notes.length === 0) return;
    return {
      content: [...event.content, { type: 'text', text: notes.join('\n\n') }],
    };
  });

  pi.on('agent_end', async (event, ctx) => {
    if (event.willContinue) return;
    const skillRoot = designHookActive(ctx.cwd);
    if (!skillRoot) return;
    // Mirrors Claude's stop_hook_active: the turn a Stop pass started cannot start another.
    const stopHookActive = designHookContinuing;
    designHookContinuing = false;
    const note = await runDesignHook(
      skillRoot,
      ctx,
      { hook_event_name: 'Stop', stop_hook_active: stopHookActive },
      STOP_HOOK_TIMEOUT_MS,
    );
    if (!note) return;
    designHookContinuing = true;
    pi.sendMessage(
      {
        customType: 'impeccable-hook',
        content: note,
        display: true,
        details: undefined,
        attribution: undefined,
      },
      { triggerTurn: true, deliverAs: 'followUp' },
    );
  });

  pi.registerCommand('impeccable', {
    description:
      'Run Impeccable design commands; live mode runs in the background',
    getArgumentCompletions: (prefix) => completions(prefix, ctxRef?.cwd),
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const tokens = tokenize(args);
      const head = tokens[0] ?? '';

      if (head === 'help' || args.trim() === '--help')
        return display(pi, helpText());
      if (head === 'install') return installOrUpdate(pi, live, ctx, 'install');
      if (head === 'update') return installOrUpdate(pi, live, ctx, 'update');

      if (head === 'live') {
        const sub = tokens[1] ?? '';
        if (sub === 'stop') return stopLive(pi, live, ctx);
        if (sub === 'status') return showLiveStatus(pi, live, ctx);
        return startLive(pi, live, ctx, tokens.slice(1));
      }
      if (head === 'stop') return stopLive(pi, live, ctx);
      if (head === 'status') return showLiveStatus(pi, live, ctx);

      if (head === 'pin')
        return pinCommand(pi, pinnedCommandNames, ctx, tokens.slice(1));
      if (head === 'unpin') return unpinCommand(pi, ctx, tokens.slice(1));
      if (head === 'hooks') return runHooksCommand(pi, ctx, tokens.slice(1));

      // Upstream routes anything else (a command, a free-form request, or nothing) through SKILL.md.
      showTransientStatus(
        ctx,
        isAgentCommand(head) ? `${head} queued` : 'request queued',
      );
      const skillRoot = await ensureSkill(pi, ctx);
      if (!skillRoot) return;
      sendExtensionPrompt(pi, ctx, commandPrompt(args, skillRoot), 'followUp');
    },
  });

  registerPinnedCommands(pi, pinnedCommandNames, process.cwd(), {
    checkConflicts: false,
  });

  // omp 18.3 Static<> ignores pi.zod schemas, so execute params are typed from _output.
  const liveReplyParams = z.object({
    id: z.string().describe('Live event id.'),
    status: z
      .enum(['done', 'partial', 'steer_done', 'error'])
      .describe('Live reply status.'),
    file: z
      .string()
      .describe('Changed file path, relative to project root.')
      .optional(),
    message: z
      .string()
      .describe('Short browser/user-facing note or error reason.')
      .optional(),
    data: z.any().describe('Manual Apply JSON payload.').optional(),
  });
  const liveCompleteParams = z.object({
    id: z.string().describe('Live event/session id.'),
    discarded: z
      .boolean()
      .describe('Set only for discard completion recovery.')
      .optional(),
    error: z
      .string()
      .describe('Record the session as failed with this reason.')
      .optional(),
    force: z
      .boolean()
      .describe(
        'Complete despite a source_dirty refusal. Use only when its findings are false positives.',
      )
      .optional(),
  });

  pi.registerTool({
    name: 'impeccable_live_reply',
    label: 'Impeccable Live Reply',
    description:
      'Reply to an Impeccable live event after handling generate, steer, manual Apply, or variant mount failure work.',
    parameters: liveReplyParams,
    async execute(
      _toolCallId,
      params: typeof liveReplyParams._output,
      signal,
      _onUpdate,
      ctx,
    ) {
      const skillRoot = live.skillRoot ?? locateSkill(ctx.cwd);
      if (!skillRoot)
        throw new Error(
          'Impeccable skill is not installed. Run /impeccable install first.',
        );
      const argv = ['--reply', params.id, params.status];
      if (params.file) argv.push('--file', params.file);
      if (params.data !== undefined)
        argv.push('--data', JSON.stringify(params.data));
      if (params.message) argv.push(params.message);

      const result = await runLauncher(
        skillRoot,
        'live-poll',
        argv,
        ctx.cwd,
        signal,
        30_000,
      );
      if (result.code !== 0)
        throw new Error(result.stderr || result.stdout || 'live reply failed');

      live.active = true;
      live.cwd = ctx.cwd;
      live.skillRoot = skillRoot;
      live.pausedFor = undefined;
      startPoll(pi, live, ctxRef ?? ctx);
      return {
        content: [
          {
            type: 'text',
            text: 'Replied to Impeccable live and resumed polling.',
          },
        ],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: 'impeccable_live_complete',
    label: 'Impeccable Live Complete',
    description:
      'Mark Impeccable live accept/carbonize cleanup complete and resume background polling.',
    parameters: liveCompleteParams,
    async execute(
      _toolCallId,
      params: typeof liveCompleteParams._output,
      signal,
      _onUpdate,
      ctx,
    ) {
      const skillRoot = live.skillRoot ?? locateSkill(ctx.cwd);
      if (!skillRoot)
        throw new Error(
          'Impeccable skill is not installed. Run /impeccable install first.',
        );
      const argv = ['--id', params.id];
      if (params.discarded) argv.push('--discarded');
      if (params.error) argv.push('--error', params.error);
      if (params.force) argv.push('--force');
      const result = await runLauncher(
        skillRoot,
        'live-complete',
        argv,
        ctx.cwd,
        signal,
        30_000,
      );
      if (result.code !== 0)
        throw new Error(
          result.stderr || result.stdout || 'live complete failed',
        );

      live.active = true;
      live.cwd = ctx.cwd;
      live.skillRoot = skillRoot;
      live.pausedFor = undefined;
      startPoll(pi, live, ctxRef ?? ctx);
      return {
        content: [
          {
            type: 'text',
            text: 'Completed Impeccable live cleanup and resumed polling.',
          },
        ],
        details: result,
      };
    },
  });
}

async function startLive(
  pi: ExtensionAPI,
  live: LiveState,
  ctx: ExtensionContext,
  tokens: string[],
) {
  if (live.poll)
    return ctx.ui.notify('Impeccable live is already polling.', 'info');
  showTransientStatus(ctx, 'live starting');

  const skillRoot = await ensureSkill(pi, ctx);
  if (!skillRoot) return;

  live.delivery = readDelivery(tokens) ?? 'steer';
  live.cwd = ctx.cwd;
  live.skillRoot = skillRoot;

  const target = targetArgs(tokens);
  const words = freeFormWords(tokens);
  // A request in prose ("the pricing page") names its target for the agent to infer, not for a guess here.
  if (words.length > 0) {
    showTransientStatus(ctx, 'live queued');
    const request = ['live', ...words, ...target].join(' ');
    sendExtensionPrompt(
      pi,
      ctx,
      liveRequestPrompt(request, skillRoot),
      'followUp',
    );
    return;
  }

  const bootArgs = [...liveBootFlags, ...target];
  const run = await runLauncher(
    skillRoot,
    'live',
    bootArgs,
    ctx.cwd,
    undefined,
    25_000,
  );
  const boot = parseJson(run.stdout) as LiveBoot | null;
  // A refusal such as no_page exits non-zero yet names its reason in JSON for the agent.
  if (run.code !== 0 && boot?.ok !== false)
    return display(
      pi,
      `Impeccable live failed:\n\n${run.stderr || run.stdout}`,
    );

  if (!boot?.ok) {
    const output = boot ?? run.stdout;
    display(
      pi,
      `Impeccable live needs setup:\n\n${JSON.stringify(output, null, 2)}`,
    );
    showTransientStatus(ctx, 'live setup queued');
    sendExtensionPrompt(
      pi,
      ctx,
      liveSetupPrompt(
        ['live', ...target].join(' '),
        skillRoot,
        bootArgs,
        output,
      ),
      'followUp',
    );
    return;
  }

  live.active = true;
  live.pausedFor = undefined;
  clearTransientStatus(ctx);
  startIndicator(live, ctx);
  startPoll(pi, live, ctx);
  await presentLivePage(pi, live, ctx, skillRoot, boot, bootArgs);
}

// Upstream reference/live.md: every boot passes all three flags, plus --target for a monorepo app.
const liveBootFlags = ['--allow-missing-context', '--dev-url', '--auto-config'];

const firstMove = 'click anything on the page, say what to change, press Go';

// live.md has the agent run the poll; here the extension does, so the agent must not.
const liveLoopNote =
  'omp-impeccable runs live-poll in the background and sends each browser event to you as a hidden message. Never run live-poll yourself: answer events with the impeccable_live_reply tool and finish carbonize cleanup with impeccable_live_complete.';

const contextCommands: Record<string, string> = {
  'PRODUCT.md': '/impeccable init',
  'DESIGN.md': '/impeccable document',
};

// `--target <path>` or `--target=<path>` as typed; a bare `--target` reaches the boot, which names the missing value.
function targetArgs(tokens: string[]) {
  const inline = tokens.find((token) => token.startsWith('--target='));
  if (inline) return [inline];
  const index = tokens.indexOf('--target');
  if (index < 0) return [];
  const value = tokens[index + 1];
  return value && !value.startsWith('-') ? ['--target', value] : ['--target'];
}

// The words that are neither flags nor a flag's value: the request's own prose.
function freeFormWords(tokens: string[]) {
  const words: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--delivery' || token === '--target') index += 1;
    else if (!token.startsWith('-')) words.push(token);
  }
  return words;
}

function shellWord(word: string) {
  return /^[\w@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", `'\\''`)}'`;
}

function liveBootCommand(skillRoot: string, args: string[]) {
  return [join(skillRoot, 'scripts', 'impeccable'), 'live', ...args]
    .map(shellWord)
    .join(' ');
}

function liveRequestPrompt(request: string, skillRoot: string) {
  return [
    commandPrompt(request, skillRoot),
    `Boot Live as live.md says: \`${liveBootCommand(skillRoot, liveBootFlags)}\`, plus \`--target <path>\` with the concrete path when the request names or implies a file, route, or app.`,
    liveLoopNote,
  ].join('\n\n');
}

function liveSetupPrompt(
  request: string,
  skillRoot: string,
  bootArgs: string[],
  output: unknown,
) {
  return [
    commandPrompt(request, skillRoot),
    `omp-impeccable ran \`${liveBootCommand(skillRoot, bootArgs)}\` and the boot did not finish. Its output:\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``,
    'live.md covers these cases (the contract, Start, and live-setup.md where it points there). Resolve it as it says, then boot again with the same command, adding --target <path> when the output asks which app to use.',
    liveLoopNote,
  ].join('\n\n');
}

function liveNoPagePrompt(
  skillRoot: string,
  boot: LiveBoot,
  bootArgs: string[],
  firstSession: boolean,
) {
  const bootCommand = liveBootCommand(skillRoot, bootArgs);
  const firstMoveNote = firstSession
    ? `, with the first move: ${firstMove}`
    : '';
  return [
    'Impeccable live is running in the background, but its boot found no page URL to open.',
    pathContract(skillRoot),
    typeof boot._instructions === 'string'
      ? `Boot instructions:\n${boot._instructions}`
      : '',
    boot.devCommand
      ? `The project's dev command is \`${boot.devCommand}\`.`
      : '',
    `Find the app's URL (check the terminal output, the dev config's port, and any open tab) and start the dev command in the background only when nothing is running. If no URL can be found, ask the user once. Once the app answers, boot again with \`${bootCommand}\`, then tell the user its URL in one line${firstMoveNote}.`,
    `The boot instructions end with a poll loop: skip it. ${liveLoopNote}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Tells the user what the boot did and where the page is, opening it for them when no page is connected yet.
// OMP's TUI paints only the last notification, so everything goes out as one.
async function presentLivePage(
  pi: ExtensionAPI,
  live: LiveState,
  ctx: ExtensionContext,
  skillRoot: string,
  boot: LiveBoot,
  bootArgs: string[],
) {
  const firstSession = !hasLiveSessions(boot, ctx.cwd);
  const url = livePageUrl(boot, ctx.cwd);
  let page =
    'Live has no page to open yet. The agent will find or start your dev server.';
  let type: 'info' | 'warning' = 'info';
  if (url) {
    // Only a page nobody has open yet, and only for a user who can see a browser.
    const clients = userCanOpenBrowser(ctx.hasUI)
      ? await connectedClients(boot)
      : undefined;
    if (!live.active) return;
    const launch =
      clients === 0
        ? await launchBrowser(url, boot.projectRoot ?? projectRoot(ctx.cwd))
        : undefined;
    if (launch?.error) type = 'warning';
    page = launch?.error
      ? `Could not open ${url} in your browser (${launch.program}: ${launch.error}). Open it yourself.`
      : launch
        ? `Opened ${url} in your browser.`
        : `Open ${url} in your browser.`;
    if (firstSession)
      page += ` First move: ${firstMove}. Pick is the crosshair in the bar at the bottom.`;
  }

  const config =
    typeof boot.liveConfigPath === 'string'
      ? relative(ctx.cwd, boot.liveConfigPath)
      : '.impeccable/live/config.json';
  const notes = [
    page,
    boot.configCreated === true && `Added ${config} to this project.`,
    missingContextNote(boot.contextMissing),
    configDriftNote(boot),
    'Say stop live or /impeccable stop to stop.',
  ];
  notifyOrDisplay(pi, ctx, notes.filter(Boolean).join(' '), type);

  if (!url)
    sendExtensionPrompt(
      pi,
      ctx,
      liveNoPagePrompt(skillRoot, boot, bootArgs, firstSession),
      'followUp',
    );
}

function missingContextNote(missing: unknown) {
  const names = Array.isArray(missing)
    ? missing.filter(
        (name): name is string =>
          typeof name === 'string' && Object.hasOwn(contextCommands, name),
      )
    : [];
  if (names.length === 0) return undefined;
  const [is, them] = names.length > 1 ? ['are', 'them'] : ['is', 'it'];
  const commands = names.map((name) => contextCommands[name]).join(' and ');
  return `${names.join(' and ')} ${is} missing. Live works without ${them}. After the session, run ${commands}.`;
}

const toldConfigDrift = new Set<string>();

// live.md: tell the user once which HTML files the config leaves out; never edit the config for them.
function configDriftNote(boot: LiveBoot) {
  const drift = boot.configDrift;
  if (!drift || typeof drift.hint !== 'string') return undefined;
  const key = boot.liveConfigPath ?? '';
  if (toldConfigDrift.has(key)) return undefined;
  toldConfigDrift.add(key);
  const files = Array.isArray(drift.orphans)
    ? drift.orphans.filter((file) => typeof file === 'string')
    : [];
  return files.length > 0
    ? `${drift.hint} Not covered: ${files.join(', ')}.`
    : drift.hint;
}

// The running dev server's origin, else the static page's file URL (the target's own when it names one).
function livePageUrl(boot: LiveBoot, cwd: string) {
  const isPage = (url: unknown): url is string =>
    typeof url === 'string' && /^(?:https?|file):\/\//.test(url);
  if (isPage(boot.devUrl)) return boot.devUrl;
  const pages = Array.isArray(boot.pageUrls)
    ? boot.pageUrls.filter(isPage)
    : [];
  const target =
    typeof boot.targetPath === 'string' ? resolve(cwd, boot.targetPath) : '';
  return pages.find((url) => fileUrlPath(url) === target) ?? pages[0];
}

function fileUrlPath(url: string) {
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

// The boot only creates the empty sessions directory: a journal file there means Live already ran in this project.
function hasLiveSessions(boot: LiveBoot, cwd: string) {
  const liveDir =
    typeof boot.roots?.sessionRoot === 'string'
      ? boot.roots.sessionRoot
      : join(boot.projectRoot ?? projectRoot(cwd), '.impeccable', 'live');
  try {
    return readdirSync(join(liveDir, 'sessions')).some((name) =>
      name.endsWith('.jsonl'),
    );
  } catch {
    return false;
  }
}

// How many browser pages the helper has connected (`GET /status`); undefined when it cannot say.
async function connectedClients(boot: LiveBoot) {
  const { serverPort: port, serverToken: token } = boot;
  if (typeof port !== 'number' || typeof token !== 'string') return undefined;
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/status?token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(2_000) },
    );
    if (!response.ok) return undefined;
    const status = (await response.json()) as { connectedClients?: unknown };
    return typeof status.connectedClients === 'number'
      ? status.connectedClients
      : undefined;
  } catch {
    return undefined;
  }
}

async function stopLive(
  pi: ExtensionAPI,
  live: LiveState,
  ctx: ExtensionContext,
) {
  showTransientStatus(ctx, 'live stopping');
  killPoll(live);
  live.active = false;
  live.pausedFor = undefined;
  const skillRoot = live.skillRoot ?? locateSkill(ctx.cwd);
  if (!skillRoot) {
    stopIndicator(live, ctx);
    return notifyOrDisplay(
      pi,
      ctx,
      'Impeccable skill is not installed.',
      'warning',
    );
  }
  const stopped = await runLauncher(
    skillRoot,
    'live-server',
    ['stop'],
    ctx.cwd,
    undefined,
    30_000,
  );
  clearTransientStatus(ctx);
  stopIndicator(live, ctx);
  if (stopped.code === 0) {
    notifyOrDisplay(pi, ctx, 'Impeccable live stopped.', 'info');
  } else {
    display(
      pi,
      `Impeccable stop failed:\n\n${stopped.stderr || stopped.stdout}`,
    );
  }
}

async function showLiveStatus(
  pi: ExtensionAPI,
  live: LiveState,
  ctx: ExtensionContext,
) {
  const skillRoot = locateSkill(ctx.cwd);
  if (!skillRoot)
    return notifyOrDisplay(
      pi,
      ctx,
      'Impeccable skill is not installed. Run /impeccable install.',
      'warning',
    );
  const status = await runLauncher(
    skillRoot,
    'live-status',
    [],
    ctx.cwd,
    undefined,
    15_000,
  );
  const output = status.stdout.trim() || status.stderr.trim();
  const message =
    status.code === 0
      ? summarizeLiveStatus(output)
      : output || 'No Impeccable live status.';
  notifyOrDisplay(pi, ctx, message, status.code === 0 ? 'info' : 'warning');
  if (live.active) renderIndicator(live, ctx);
}

async function installOrUpdate(
  pi: ExtensionAPI,
  live: LiveState,
  ctx: ExtensionContext,
  action: 'install' | 'update',
) {
  showTransientStatus(ctx, `${action} started`);
  const previousVersion = skillVersion(projectOmpSkillRoot(ctx.cwd));
  const installed = await installProjectOmpSkill(ctx.cwd);

  clearTransientStatus(ctx);
  if (live.active) renderIndicator(live, ctx);
  else stopIndicator(live, ctx);
  if (installed.result.code !== 0 || !installed.skillRoot) {
    const message =
      installed.result.code !== 0
        ? installed.result.stderr ||
          installed.result.stdout ||
          `impeccable ${action} failed`
        : `.omp/skills/impeccable was not found after staging the upstream install`;
    return notifyOrDisplay(pi, ctx, message, 'error');
  }
  const done = `Impeccable ${action} complete.`;
  const report =
    action === 'update'
      ? await doctorReport(
          ctx,
          installed.skillRoot,
          skillVersion(installed.skillRoot) !== previousVersion,
        )
      : undefined;
  // One message: a notification right before a displayed message is never painted.
  if (report) display(pi, `${done}\n\n${report}`);
  else notifyOrDisplay(pi, ctx, done, 'info');
}

// Upstream `impeccable update` ends with the doctor report: the new skill may read the project's files
// differently from the version that wrote them. A report only; the fixes are `/impeccable doctor`'s.
async function doctorReport(
  ctx: ExtensionContext,
  skillRoot: string,
  updated: boolean,
) {
  const doctor = await runLauncher(skillRoot, 'doctor', [], ctx.cwd);
  const report = doctor.stdout.trim();
  if (doctor.code !== 0 || !report) return undefined;
  const next = updated
    ? "\n\nNext step: run /impeccable doctor. It checks this project's setup against the version you just installed and offers the fixes."
    : '';
  return `${report}${next}`;
}

function skillVersion(skillRoot: string) {
  try {
    const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
    return /^version:\s*(\S+)\s*$/m.exec(skill)?.[1];
  } catch {
    return undefined;
  }
}

async function ensureSkill(pi: ExtensionAPI, ctx: ExtensionContext) {
  const projectSkill = ensureProjectOmpSkill(ctx.cwd);
  if (projectSkill) return projectSkill;
  display(
    pi,
    'Impeccable is not installed for this project. Installing the latest upstream skill into .omp/skills/impeccable...',
  );
  const installed = await installProjectOmpSkill(ctx.cwd);
  if (installed.result.code !== 0) {
    display(
      pi,
      `Impeccable install failed:\n\n${installed.result.stderr || installed.result.stdout}`,
    );
    return null;
  }
  if (!installed.skillRoot) {
    display(
      pi,
      `Impeccable install ran, but .omp/skills/impeccable was not found after staging the upstream install. Output:\n\n${installed.result.stdout}`,
    );
    return null;
  }
  return installed.skillRoot;
}

function startPoll(pi: ExtensionAPI, live: LiveState, ctx: ExtensionContext) {
  if (!live.active || !live.skillRoot) return;
  startIndicator(live, ctx);
  if (live.poll) return;
  const cwd = live.cwd ?? ctx.cwd;
  // --json bounds an accept's account upload at two seconds and puts the saved page on the event as savedTo.
  const child = spawn(
    join(live.skillRoot, 'scripts', 'impeccable'),
    ['live-poll', '--json'],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  live.poll = child;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  child.on('error', (error) => {
    if (live.poll !== child) return;
    live.poll = undefined;
    if (live.active) reportPollFailure(live, ctx, error);
  });
  child.on('close', (code) => {
    // A throw here is an uncaughtException that ends the omp session.
    try {
      if (live.poll !== child) return;
      live.poll = undefined;
      if (!live.active) return;
      if (code !== 0) {
        live.pausedFor = 'poll-error';
        renderIndicator(live, ctx);
        display(pi, `Impeccable live poll failed:\n\n${stderr || stdout}`);
        ctx.ui.notify(
          'Impeccable live poll failed; run /impeccable live to resume.',
          'warning',
        );
        return;
      }
      const event = asLiveEvent(parseJson(stdout));
      if (!event) {
        live.pausedFor = 'parse-error';
        renderIndicator(live, ctx);
        display(
          pi,
          `Could not parse Impeccable live event:\n\n${stdout}\n${stderr}`,
        );
        return;
      }
      handleLiveEvent(pi, live, ctx, event, stderr);
    } catch (error) {
      reportPollFailure(live, ctx, error);
    }
  });
}

function handleLiveEvent(
  pi: ExtensionAPI,
  live: LiveState,
  ctx: ExtensionContext,
  event: LiveEventData,
  stderr: string,
) {
  live.lastEvent = event;
  if (event.type === 'timeout') return startPoll(pi, live, ctx);
  if (event.type === 'exit') {
    live.active = false;
    stopIndicator(live, ctx);
    ctx.ui.notify('Impeccable live exited.', 'info');
    return;
  }
  if (event.type === 'prefetch') return startPoll(pi, live, ctx);

  const saved =
    typeof event.savedTo === 'string'
      ? `Saved to Impeccable: ${event.savedTo}`
      : undefined;
  const needsAgent =
    agentReplyEvents.has(event.type) || needsLiveComplete(event);
  if (!needsAgent) {
    ctx.ui.notify(
      saved
        ? `Impeccable live: ${event.type}. ${saved}`
        : `Impeccable live: ${event.type}`,
      'info',
    );
    return startPoll(pi, live, ctx);
  }
  if (saved) ctx.ui.notify(saved, 'info');

  const skillRoot = live.skillRoot;
  if (!skillRoot) return;
  live.pausedFor = event.id ?? event.type;
  sendLiveEvent(
    pi,
    ctx,
    liveEventPrompt(event, stderr, skillRoot),
    event,
    live.delivery,
  );
}

function liveEventPrompt(
  event: LiveEventData,
  stderr: string,
  skillRoot: string,
) {
  const next = needsLiveComplete(event)
    ? `After cleanup, call impeccable_live_complete with id ${JSON.stringify(event.id)}. Do not poll manually.`
    : `After handling the event, call impeccable_live_reply with id ${JSON.stringify(event.id)} and the correct status. Do not reply with bash.`;
  return [
    'Impeccable live event arrived from the background poll.',
    pathContract(skillRoot),
    `Read the live reference if it is not already loaded: ${join(skillRoot, 'reference', 'live.md')}`,
    stderr.trim() ? `Poll stderr:\n${stderr.trim()}` : '',
    'Event JSON:',
    `\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``,
    next,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function needsLiveComplete(event: LiveEventData) {
  return (
    event.type === 'carbonize_cleanup' ||
    event._acceptResult?.carbonize === true ||
    event._completionAck?.ok === false
  );
}

/** The type of the live event the agent still owes a reply or cleanup for. */
function pendingLiveEvent(live: LiveState) {
  const { pausedFor } = live;
  if (!pausedFor || pausedFor === 'poll-error' || pausedFor === 'parse-error')
    return undefined;
  return live.lastEvent?.type ?? pausedFor;
}

async function pinCommand(
  pi: ExtensionAPI,
  pinnedCommandNames: Set<string>,
  ctx: ExtensionContext,
  tokens: string[],
) {
  const command = tokens[0] ?? '';
  if (!command) {
    return display(pi, 'Usage: /impeccable pin <upstream-command>');
  }
  if (!isSafeCommandName(command) || !isAgentCommand(command)) {
    return notifyOrDisplay(
      pi,
      ctx,
      `Cannot pin ${command || 'empty command'}; choose an upstream Impeccable command.`,
      'warning',
    );
  }
  const file = pinnedCommandPath(ctx.cwd, command);
  if (hasCommandFileConflict(ctx.cwd, command)) {
    return notifyOrDisplay(
      pi,
      ctx,
      `Cannot overwrite existing OMP command file: ${file}`,
      'warning',
    );
  }
  if (hasCommandConflict(pi, ctx.cwd, command, pinnedCommandNames)) {
    return notifyOrDisplay(
      pi,
      ctx,
      `Cannot pin /${command}; an OMP slash command with that name already exists.`,
      'warning',
    );
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, pinnedCommandContent(command));
  registerPinnedCommand(pi, pinnedCommandNames, command);
  return notifyOrDisplay(
    pi,
    ctx,
    `Pinned /${command} to /impeccable ${command} in .omp/commands/${command}.md.`,
  );
}

function unpinCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  tokens: string[],
) {
  const command = tokens[0] ?? '';
  if (!command) {
    return display(pi, 'Usage: /impeccable unpin <upstream-command>');
  }
  if (!isSafeCommandName(command)) {
    return notifyOrDisplay(
      pi,
      ctx,
      `Invalid pinned command: ${command}`,
      'warning',
    );
  }

  const file = pinnedCommandPath(ctx.cwd, command);
  if (!existsSync(file)) {
    return notifyOrDisplay(pi, ctx, `/${command} is not pinned.`, 'info');
  }
  if (!isPinnedCommandFile(file, command)) {
    return notifyOrDisplay(
      pi,
      ctx,
      `Refusing to remove non-omp-impeccable command file: ${file}`,
      'warning',
    );
  }

  rmSync(file);
  return notifyOrDisplay(
    pi,
    ctx,
    `Removed .omp/commands/${command}.md. Reload OMP to remove /${command} from autocomplete.`,
  );
}

// Same budgets as upstream's manifests and Hermes plugin: 5 s per edit, 30 s for the Stop deep pass.
const EDIT_HOOK_TIMEOUT_MS = 5_000;
const STOP_HOOK_TIMEOUT_MS = 30_000;

// The summary lines `impeccable hooks on|status` print when no harness manifest is wired.
const HOOKS_NOT_WIRED = /No design harness is wired|not wired in any harness/;
const HOOKS_NOT_WIRED_NOTE =
  'omp-impeccable overrides any "No design harness is wired" or "not wired in any harness" line above. Upstream Impeccable checks only harness manifests and cannot see OMP, but the omp-impeccable design hook is active in this session: it runs after edit and write tool calls and again when you finish. You may tell the user the design hook will run.';

async function runHooksCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string[],
) {
  const skillRoot = await ensureSkill(pi, ctx);
  if (!skillRoot) return;
  const result = await runLauncher(skillRoot, 'hooks', args, ctx.cwd);
  const output = (result.stdout || result.stderr).trim();
  if (result.code !== 0)
    return notifyOrDisplay(
      pi,
      ctx,
      output || 'impeccable hooks failed',
      'error',
    );
  const note = designHookActive(ctx.cwd)
    ? '\n\nomp-impeccable runs this hook after edit and write tool calls and again when the agent finishes. Ignore any "not wired" line above: upstream checks only harness manifests and cannot see OMP.'
    : '';
  display(pi, `${output}${note}`);
}

// Active once `hooks on` records local consent and the project has not turned the hook off.
function designHookActive(cwd: string) {
  const skillRoot = projectOmpSkillRoot(cwd);
  if (!isSkillRoot(skillRoot)) return undefined;
  const dir = join(projectRoot(cwd), '.impeccable');
  const read = (name: string) =>
    existsSync(join(dir, name))
      ? parseJson(readFileSync(join(dir, name), 'utf8'))
      : null;
  const local = read('config.local.json') as {
    hook?: { consent?: unknown };
  } | null;
  const shared = read('config.json') as {
    hook?: { enabled?: unknown };
  } | null;
  if (local?.hook?.consent !== 'accepted') return undefined;
  if (shared?.hook?.enabled === false) return undefined;
  return skillRoot;
}

function changedFiles(
  cwd: string,
  input: Record<string, unknown>,
  details: unknown,
) {
  const files = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value) files.add(resolve(cwd, value));
  };
  add(input.path);
  if (details && typeof details === 'object') {
    const { path, perFileResults } = details as {
      path?: unknown;
      perFileResults?: unknown;
    };
    add(path);
    if (Array.isArray(perFileResults))
      for (const entry of perFileResults) add(entry?.path);
  }
  return [...files];
}

async function runDesignHook(
  skillRoot: string,
  ctx: ExtensionContext,
  event: Record<string, unknown>,
  timeoutMs: number,
) {
  // Stop discovery dates the session from a UUIDv7 session id, else the transcript file's birth time.
  const transcriptPath = ctx.sessionManager.getSessionFile();
  const result = await runLauncher(
    skillRoot,
    'hook',
    [],
    ctx.cwd,
    undefined,
    timeoutMs,
    JSON.stringify({
      ...event,
      session_id: ctx.sessionManager.getSessionId(),
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
      cwd: ctx.cwd,
    }),
  );
  if (result.code !== 0) return undefined;
  const output = parseJson(result.stdout) as {
    hookSpecificOutput?: { additionalContext?: unknown };
    additionalContext?: unknown;
    reason?: unknown;
  } | null;
  const text =
    output?.hookSpecificOutput?.additionalContext ??
    output?.additionalContext ??
    output?.reason;
  return typeof text === 'string' && text.trim() ? text : undefined;
}

function registerPinnedCommands(
  pi: ExtensionAPI,
  pinnedCommandNames: Set<string>,
  cwd: string,
  { checkConflicts = true }: { checkConflicts?: boolean } = {},
) {
  for (const command of pinnedCommands(cwd)) {
    if (
      checkConflicts &&
      hasCommandConflict(pi, cwd, command, pinnedCommandNames)
    )
      continue;
    registerPinnedCommand(pi, pinnedCommandNames, command);
  }
}

function registerPinnedCommand(
  pi: ExtensionAPI,
  pinnedCommandNames: Set<string>,
  command: string,
) {
  if (pinnedCommandNames.has(command)) return;
  pinnedCommandNames.add(command);
  pi.registerCommand(command, {
    description: pinnedCommandDescription(command),
    handler: async (args, ctx) => {
      if (!isPinnedCommand(ctx.cwd, command)) {
        return notifyOrDisplay(
          pi,
          ctx,
          `/${command} is not pinned in this project. Run /impeccable pin ${command} to restore it.`,
          'warning',
        );
      }
      showTransientStatus(ctx, `${command} queued`);
      const skillRoot = await ensureSkill(pi, ctx);
      if (!skillRoot) return;
      const invocation = [command, args.trim()].filter(Boolean).join(' ');
      sendExtensionPrompt(
        pi,
        ctx,
        commandPrompt(invocation, skillRoot),
        'followUp',
      );
    },
  });
}

function pinnedCommandDescription(command: string) {
  return `Run /impeccable ${command} through omp-impeccable`;
}

function pinnedCommands(cwd: string) {
  const commandsDir = join(projectRoot(cwd), '.omp', 'commands');
  try {
    return readdirSync(commandsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -'.md'.length))
      .filter(
        (command) =>
          isSafeCommandName(command) &&
          isPinnedCommandFile(join(commandsDir, `${command}.md`), command),
      );
  } catch {
    return [];
  }
}

function hasCommandConflict(
  pi: ExtensionAPI,
  cwd: string,
  command: string,
  pinnedCommandNames: ReadonlySet<string>,
) {
  const hasRegisteredPinnedCommand = pinnedCommandNames.has(command);
  const hasManagedPinnedFile = isPinnedCommand(cwd, command);
  const knownPinnedCommand = hasRegisteredPinnedCommand || hasManagedPinnedFile;
  if (hasCommandFileConflict(cwd, command)) return true;

  const commandFile = pinnedCommandPath(cwd, command);
  const commands = pi.getCommands();
  return commands.some((candidate) => {
    if (candidate.name !== command) return false;
    if (!knownPinnedCommand) return true;
    if (
      candidate.source === 'extension' &&
      hasRegisteredPinnedCommand &&
      candidate.description === pinnedCommandDescription(command)
    )
      return false;
    if (
      candidate.source === 'prompt' &&
      candidate.path &&
      hasManagedPinnedFile &&
      resolve(candidate.path) === resolve(commandFile)
    )
      return false;
    return true;
  });
}

function hasCommandFileConflict(cwd: string, command: string) {
  const file = pinnedCommandPath(cwd, command);
  return existsSync(file) && !isPinnedCommandFile(file, command);
}

function isPinnedCommand(cwd: string, command: string) {
  return (
    isSafeCommandName(command) &&
    isPinnedCommandFile(pinnedCommandPath(cwd, command), command)
  );
}

function isPinnedCommandFile(file: string, command: string) {
  try {
    const content = readFileSync(file, 'utf8');
    return (
      content.includes('managed-by: omp-impeccable') &&
      content.includes(`impeccable-command: ${command}`)
    );
  } catch {
    return false;
  }
}

function pinnedCommandPath(cwd: string, command: string) {
  return join(projectRoot(cwd), '.omp', 'commands', `${command}.md`);
}

function isSafeCommandName(command: string) {
  if (command.length === 0 || command.length > 63) return false;
  if (!isLowerAsciiLetter(command.charCodeAt(0))) return false;

  for (let index = 1; index < command.length; index += 1) {
    const charCode = command.charCodeAt(index);
    if (
      !isLowerAsciiLetter(charCode) &&
      !isAsciiDigit(charCode) &&
      command[index] !== '_' &&
      command[index] !== '-'
    ) {
      return false;
    }
  }

  return true;
}

function isLowerAsciiLetter(charCode: number) {
  return charCode >= 97 && charCode <= 122;
}

function isAsciiDigit(charCode: number) {
  return charCode >= 48 && charCode <= 57;
}

function pinnedCommandContent(command: string) {
  return `---
description: Run /impeccable ${command} through omp-impeccable
managed-by: omp-impeccable
impeccable-command: ${command}
---
Handle this Impeccable invocation in OMP: /impeccable ${command} $ARGUMENTS

The omp-impeccable extension handles /${command} directly when loaded. This file keeps a native OMP command placeholder and safe fallback prompt.
`;
}

function commandPrompt(args: string, skillRoot: string) {
  return [
    `Handle this Impeccable invocation in OMP: /impeccable ${args.trim()}`.trimEnd(),
    pathContract(skillRoot),
    `Start by reading ${join(skillRoot, 'SKILL.md')}.`,
    'If a sub-command is invoked, read the matching reference file from that skill root before acting.',
  ].join('\n\n');
}

function pathContract(skillRoot: string) {
  return [
    'Use the Impeccable files installed by the upstream Impeccable package, not vendored extension files.',
    `Skill root: ${skillRoot}`,
    `Scripts: ${join(skillRoot, 'scripts')}`,
    'Whenever upstream Impeccable docs mention `.agents/skills/impeccable/scripts/impeccable`, run the `impeccable` launcher from `Scripts` instead.',
  ].join('\n');
}

function isForegroundLivePoll(command: string) {
  if (command.includes('--reply')) return false;
  return /\bimpeccable\s+(?:live-)?poll\b/.test(command);
}

// `build-phase` records the build owner from IMPECCABLE_SESSION_ID (OMP only sets PI_SESSION_ID), and
// the Stop hook reminds only that owner of unfinished work. Upstream rewrites Gemini shell calls alike.
function withBuildSessionIdentity(command: string, sessionId: string) {
  if (process.platform === 'win32') return undefined;
  if (
    !/\bimpeccable(?:\.cmd)?['"]?\s+build-phase\b/.test(command) ||
    command.includes('--session-id')
  )
    return undefined;
  if (!/^[A-Za-z0-9_:.-]{1,200}$/.test(sessionId)) return undefined;
  const prefix = `export IMPECCABLE_SESSION_ID='${sessionId}'\n`;
  return command.startsWith(prefix) ? undefined : `${prefix}${command}`;
}

// Impeccable's decision page and component review exit "no browser" when CI is set. OMP sets CI=true in every
// shell command it runs, so its own environment, not the shell's, says whether a user can open the page.
function userCanOpenBrowser(
  hasUI: boolean,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const set = (key: string) => !!env[key];
  if (!hasUI || set('CI') || set('IMPECCABLE_QUESTION_DISABLED')) return false;
  if (set('SSH_CONNECTION') && !set('DISPLAY')) return false;
  return platform !== 'linux' || set('DISPLAY') || set('WAYLAND_DISPLAY');
}

// Upstream's override for that check. omp recaptures process.env for its shells after session_start handlers,
// so the value reaches every command unchanged: a rewritten command makes the agent think it wrote the
// export itself. Leaves a value the user set alone, and withdraws only its own.
function exportBrowserForce(canOpenBrowser: boolean, exportedBefore: boolean) {
  if (canOpenBrowser && !process.env.IMPECCABLE_QUESTION_FORCE) {
    process.env.IMPECCABLE_QUESTION_FORCE = '1';
    return true;
  }
  if (!canOpenBrowser && exportedBefore) {
    delete process.env.IMPECCABLE_QUESTION_FORCE;
    return false;
  }
  return exportedBefore;
}

// A started decision page (`serve-question --start`) does not open the browser unless given --open,
// and component-review serve never does; both print their URL for the harness to open.
function opensNoBrowserItself(command: string) {
  if (/\bimpeccable(?:\.cmd)?['"]?\s+component-review\s+serve\b/.test(command))
    return true;
  return (
    /\bimpeccable(?:\.cmd)?['"]?\s+serve-question\b/.test(command) &&
    /\s--start\b/.test(command) &&
    !/\s--open\b/.test(command)
  );
}

function servedPageUrl(text: string) {
  let url = /^QUESTION URL: (\S+)$/m.exec(text)?.[1];
  const review = /^COMPONENT REVIEW: (\{.*\})$/m.exec(text)?.[1];
  if (!url && review) {
    const service = parseJson(review) as { url?: unknown } | null;
    if (typeof service?.url === 'string') url = service.url;
  }
  // Only the loopback servers Impeccable starts; a URL elsewhere in the output is not a page to open.
  return url &&
    /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\//.test(url)
    ? url
    : undefined;
}

function textOf(content: unknown) {
  if (!Array.isArray(content)) return '';
  return content
    .map((block: { type?: unknown; text?: unknown }) =>
      block?.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '',
    )
    .join('\n');
}

// Opens each served page once per session and resolves to the note the tool result carries.
function openServedPage(
  pages: Map<string, Promise<string>>,
  command: unknown,
  output: string,
  ctx: ExtensionContext,
) {
  if (typeof command !== 'string' || !opensNoBrowserItself(command))
    return undefined;
  const url = servedPageUrl(output);
  if (!url || !userCanOpenBrowser(ctx.hasUI)) return undefined;
  let opened = pages.get(url);
  if (!opened) {
    opened = openPage(url, ctx);
    pages.set(url, opened);
  }
  return opened;
}

// Starts the user's browser on the page; `error` says why it would not start.
async function launchBrowser(url: string, root: string) {
  const [program, args] = browserCommand(url, root);
  const { promise: spawned, resolve: done } = Promise.withResolvers<
    string | undefined
  >();
  const child = spawn(program, args, { stdio: 'ignore', detached: true });
  child.once('spawn', () => {
    child.unref();
    done(undefined);
  });
  child.once('error', (err) => done(err.message));
  return { program, error: await spawned };
}

async function openPage(url: string, ctx: ExtensionContext) {
  const { program, error } = await launchBrowser(url, projectRoot(ctx.cwd));
  if (error) {
    ctx.ui.notify(
      `Open the Impeccable page in your browser: ${url} (${program}: ${error})`,
      'warning',
    );
    return `omp-impeccable could not open ${url} in the user's browser (${program}: ${error}). Show the user that URL.`;
  }
  ctx.ui.notify(`Opened the Impeccable page in your browser: ${url}`, 'info');
  return `omp-impeccable opened ${url} in the user's browser. Do not open it again or in the browser tool; wait for the user's decision.`;
}

// Upstream's browser preference (crates/live/src/browser_open.rs): IMPECCABLE_BROWSER, then `browser` in
// .impeccable/config.local.json or config.json, then BROWSER, then the platform's opener. A path runs with
// the URL; on macOS any other value names an application.
export function browserCommand(
  url: string,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  const configured = (name: string) => {
    const file = join(root, '.impeccable', name);
    const config = existsSync(file)
      ? (parseJson(readFileSync(file, 'utf8')) as { browser?: unknown } | null)
      : null;
    return typeof config?.browser === 'string' ? config.browser.trim() : '';
  };
  const preference =
    env.IMPECCABLE_BROWSER?.trim() ||
    configured('config.local.json') ||
    configured('config.json') ||
    env.BROWSER?.trim();
  if (preference) {
    if (/[/\\]/.test(preference) || existsSync(preference))
      return [preference, [url]];
    if (platform === 'darwin') return ['open', ['-a', preference, url]];
    if (platform === 'win32')
      return ['cmd', ['/c', 'start', '', preference, url]];
    return [preference, [url]];
  }
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

// Upstream `impeccable context` sees no OMP hook manifest, so it asks for a manual detector run
// that this extension's design hook already covers.
function withManualDetectorOverride(
  content: ToolResultEvent['content'],
  cwd: string,
) {
  const directive = content.some(
    (block) =>
      block.type === 'text' && block.text.includes('MANUAL_DETECTOR_REQUIRED:'),
  );
  if (!directive || !designHookActive(cwd)) return undefined;
  return {
    content: [
      ...content,
      {
        type: 'text' as const,
        text: 'omp-impeccable overrides the MANUAL_DETECTOR_REQUIRED line above. Upstream Impeccable cannot see OMP hooks, but the omp-impeccable design hook is active in this session: it runs after edit and write tool calls and when you finish. Skip that manual detector run.',
      },
    ],
  };
}

// Upstream `hooks on` and `hooks status` read only harness manifests, so in OMP they report the hook as
// not wired and `reference/hooks.md` tells the agent not to claim it runs.
function withHooksNotWiredOverride(
  content: ToolResultEvent['content'],
  command: unknown,
  cwd: string,
) {
  if (typeof command !== 'string' || !/\bhooks\b/.test(command))
    return undefined;
  const notWired = content.some(
    (block) => block.type === 'text' && HOOKS_NOT_WIRED.test(block.text),
  );
  if (!notWired || !designHookActive(cwd)) return undefined;
  return {
    content: [
      ...content,
      { type: 'text' as const, text: HOOKS_NOT_WIRED_NOTE },
    ],
  };
}

function readDelivery(tokens: string[]): Delivery | undefined {
  const value = option(tokens, 'delivery');
  if (value === 'followUp' || value === 'followup') return 'followUp';
  if (value === 'steer') return 'steer';
  if (value === 'aside') return 'aside';
  if (tokens.includes('--follow-up')) return 'followUp';
  if (tokens.includes('--aside')) return 'aside';
  return undefined;
}

function option(tokens: string[], name: string) {
  const prefix = `--${name}=`;
  const inline = tokens.find((token) => token.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = tokens.indexOf(`--${name}`);
  return idx >= 0 ? tokens[idx + 1] : undefined;
}

function tokenize(input: string) {
  return (input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    token.replace(/^(["'])(.*)\1$/, '$2'),
  );
}

export function summarizeLiveStatus(output: string) {
  const status = parseJson(output);
  if (!status || typeof status !== 'object')
    return output || 'No Impeccable live status.';
  const liveServer = (status as { liveServer?: unknown }).liveServer;
  const sessions = Array.isArray(
    (status as { activeSessions?: unknown }).activeSessions,
  )
    ? (
        status as {
          activeSessions: Array<{
            phase?: unknown;
            pageUrl?: unknown;
            sourceFile?: unknown;
          }>;
        }
      ).activeSessions
    : [];
  const server = liveServer ? 'server running' : 'server stopped';
  if (sessions.length === 0)
    return `Impeccable live: ${server} · no active sessions`;
  const first = sessions[0];
  const phase =
    typeof first?.phase === 'string'
      ? first.phase.replace(/_/g, ' ')
      : 'active';
  const target =
    typeof first?.sourceFile === 'string'
      ? first.sourceFile
      : typeof first?.pageUrl === 'string'
        ? first.pageUrl
        : 'session';
  const more = sessions.length > 1 ? ` · +${sessions.length - 1} more` : '';
  return `Impeccable live: ${server} · ${phase} · ${target}${more}`;
}

function isAgentCommand(command: string) {
  return (agentCommands as readonly string[]).includes(command);
}

function completions(prefix: string, cwd = process.cwd()) {
  const trimmedStart = prefix.trimStart();
  if (/\s/.test(trimmedStart)) return null;
  const descriptions = installedCommandDescriptions(cwd);
  const commands = [...extensionCommandDescriptions.keys(), ...agentCommands];
  const matches = commands.filter((command) =>
    command.startsWith(trimmedStart),
  );
  return matches.length
    ? matches.map((value) => {
        const description =
          descriptions.get(value) ??
          extensionCommandDescriptions.get(value) ??
          fallbackAgentCommandDescriptions.get(value);
        return description
          ? { value, label: value, description }
          : { value, label: value };
      })
    : null;
}

function installedCommandDescriptions(cwd: string) {
  const skillRoot = locateSkill(cwd);
  if (!skillRoot) return new Map<string, string>();

  try {
    return parseCommandMetadata(
      readFileSync(join(skillRoot, 'scripts', 'command-metadata.json'), 'utf8'),
    );
  } catch {
    return new Map<string, string>();
  }
}

export function parseCommandMetadata(json: string) {
  const parsed: unknown = JSON.parse(json);
  const descriptions = new Map<string, string>();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return descriptions;

  for (const [command, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const description = (entry as { description?: unknown }).description;
    if (typeof description !== 'string' || !description.trim()) continue;
    descriptions.set(command, cleanDescription(description));
  }

  return descriptions;
}

function cleanDescription(description: string) {
  return description
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

let cancelTransientStatusTimer: (() => void) | undefined;

function sendExtensionPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
  text: string,
  delivery: Delivery,
) {
  const options = ctx?.isIdle()
    ? { triggerTurn: true }
    : { triggerTurn: true, deliverAs: delivery };
  pi.sendMessage(
    {
      customType: 'impeccable-command',
      content: text,
      display: false,
      details: undefined,
      attribution: undefined,
    },
    options,
  );
}

function sendLiveEvent(
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
  text: string,
  event: LiveEventData,
  delivery: Delivery,
) {
  ctx?.ui.notify(
    `Impeccable live: ${event.type}${event.action ? ` ${event.action}` : ''}`,
    'info',
  );
  const options = ctx?.isIdle()
    ? { triggerTurn: true }
    : { triggerTurn: true, deliverAs: delivery };
  pi.sendMessage(
    {
      customType: 'impeccable-live',
      content: text,
      display: false,
      details: undefined,
      attribution: undefined,
    },
    options,
  );
}

function notifyOrDisplay(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  content: string,
  type: 'info' | 'warning' | 'error' = 'info',
) {
  if (ctx.hasUI) ctx.ui.notify(content, type);
  else display(pi, content);
}

// Help, usage and command output are for the user; omp 19.0.0+ keeps them out of the model's context.
function display(pi: ExtensionAPI, content: string) {
  pi.sendMessage({
    customType: 'impeccable',
    content,
    display: true,
    details: undefined,
    attribution: undefined,
    excludeFromContext: true,
  });
}

function clearTransientStatus(ctx?: ExtensionContext) {
  cancelTransientStatusTimer?.();
  cancelTransientStatusTimer = undefined;
  ctx?.ui.setStatus('impeccable-transient', undefined);
}

function showTransientStatus(ctx: ExtensionContext, text: string) {
  if (!ctx.hasUI) return;
  clearTransientStatus(ctx);
  ctx.ui.setStatus('impeccable-transient', `✦ impeccable ${text}`);
  const timer = ctx.setTimeout(() => {
    cancelTransientStatusTimer = undefined;
    ctx.ui.setStatus('impeccable-transient', undefined);
  }, 3500);
  cancelTransientStatusTimer = () => ctx.clearTimer(timer);
}

function killPoll(live: LiveState) {
  if (!live.poll) return;
  live.poll.kill('SIGTERM');
  live.poll = undefined;
}

function reportPollFailure(
  live: LiveState,
  ctx: ExtensionContext,
  error: unknown,
) {
  live.pausedFor = 'poll-error';
  const message = error instanceof Error ? error.message : String(error);
  try {
    renderIndicator(live, ctx);
    ctx.ui.notify(
      `Impeccable live error: ${message}; run /impeccable live to resume.`,
      'error',
    );
  } catch {
    // ctx can be stale after a session switch; nothing is left to report to.
  }
}

function startIndicator(live: LiveState, ctx: ExtensionContext) {
  renderIndicator(live, ctx);
}

function stopIndicator(_live: LiveState, ctx?: ExtensionContext) {
  ctx?.ui.setStatus('impeccable', undefined);
}

function renderIndicator(live: LiveState, ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  if (!live.active) return stopIndicator(live, ctx);
  const label = (state: 'live' | 'event' | 'error') => `✦ impeccable ${state}`;
  if (live.pausedFor === 'poll-error' || live.pausedFor === 'parse-error') {
    ctx.ui.setStatus('impeccable', label('error'));
    return;
  }
  if (live.pausedFor) {
    ctx.ui.setStatus('impeccable', label('event'));
    return;
  }
  ctx.ui.setStatus('impeccable', label('live'));
}

// Files, processes, and JSON.
function locateSkill(cwd: string) {
  const candidates = [
    projectOmpSkillRoot(cwd),
    join(cwd, '.omp', 'skills', 'impeccable'),
    join(homedir(), '.omp', 'agent', 'skills', 'impeccable'),
    projectAgentsSkillRoot(cwd),
    join(cwd, '.agents', 'skills', 'impeccable'),
    join(homedir(), '.agents', 'skills', 'impeccable'),
  ];
  return [...new Set(candidates)].find(isSkillRoot);
}

function ensureProjectOmpSkill(cwd: string) {
  const skillRoot = projectOmpSkillRoot(cwd);
  if (isSkillRoot(skillRoot)) return skillRoot;
  // An existing upstream install in .agents: copy it into .omp and repoint its paths.
  const legacyRoot = projectAgentsSkillRoot(cwd);
  if (!isSkillRoot(legacyRoot)) return undefined;
  const migrated = replaceProjectOmpSkill(legacyRoot, cwd);
  if (migrated) rewriteSkillRootReferences(migrated);
  return migrated;
}

async function installProjectOmpSkill(cwd: string) {
  const stagingRoot = mkdtempSync(join(tmpdir(), 'omp-impeccable-install-'));
  try {
    mkdirSync(join(stagingRoot, '.git'));
    const result = await runImpeccable(
      [
        'install',
        '--providers=omp,claude-code',
        '--scope=project',
        '-y',
        '--no-hooks',
        '--force',
      ],
      stagingRoot,
      undefined,
      120_000,
    );
    if (result.code !== 0) return { result, skillRoot: undefined };
    // OMP skips .claude/agents, so the Claude build only supplies the shipped subagents.
    const skillRoot = replaceProjectOmpSkill(
      join(stagingRoot, '.omp', 'skills', 'impeccable'),
      cwd,
    );
    if (skillRoot)
      replaceProjectOmpAgents(join(stagingRoot, '.claude', 'agents'), cwd);
    return { result, skillRoot };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function replaceProjectOmpSkill(source: string, cwd: string) {
  if (!isSkillRoot(source)) return undefined;

  const dest = projectOmpSkillRoot(cwd);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(source, dest, { recursive: true });
  if (!isSkillRoot(dest)) return undefined;
  return dest;
}

function rewriteSkillRootReferences(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteSkillRootReferences(path);
      continue;
    }
    if (!entry.isFile() || !isTextSkillFile(entry.name)) continue;

    const content = readFileSync(path, 'utf8');
    const next = rewriteSkillPaths(content);
    if (next !== content) writeFileSync(path, next);
  }
}

function rewriteSkillPaths(text: string) {
  return text.replace(
    /\.(?:agents|pi|claude)\/skills\/impeccable/g,
    '.omp/skills/impeccable',
  );
}

function replaceProjectOmpAgents(source: string, cwd: string) {
  const dest = join(projectRoot(cwd), '.omp', 'agents');
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(dest)) {
    const path = join(dest, entry);
    if (
      entry.endsWith('.md') &&
      /^managed-by: omp-impeccable$/m.test(readFileSync(path, 'utf8'))
    )
      rmSync(path);
  }
  if (!existsSync(source)) return;
  for (const entry of readdirSync(source)) {
    if (!entry.endsWith('.md')) continue;
    const agent = readFileSync(join(source, entry), 'utf8');
    writeFileSync(join(dest, entry), ompAgent(agent));
  }
}

// OMP reads Claude agent frontmatter except `model: inherit` (omitting model inherits), `effort`, and
// `disallowedTools`: OMP has only a `tools` allowlist, beside which extension and MCP tools stay available.
export function ompAgent(claudeAgent: string) {
  return rewriteSkillPaths(claudeAgent).replace(
    /^---\n([\s\S]*?)\n---\n/,
    (_match, frontmatter: string) => {
      const source = frontmatter.split('\n');
      const lines: string[] = [];
      let disallowed: string[] | undefined;
      for (let index = 0; index < source.length; index++) {
        const line = source[index];
        if (/^model:\s*inherit\s*$/.test(line)) continue;
        const field = /^(?:disallowedTools|disallowed-tools):\s*(.*)$/.exec(
          line,
        );
        if (!field) {
          lines.push(line.replace(/^effort:/, 'thinkingLevel:'));
          continue;
        }
        disallowed = field[1].split(',');
        while (/^\s+-\s/.test(source[index + 1] ?? ''))
          disallowed.push(source[++index].replace(/^\s+-\s*/, ''));
      }
      if (disallowed) allowTools(lines, disallowed);
      return `---\n${[...lines, 'managed-by: omp-impeccable'].join('\n')}\n---\n`;
    },
  );
}

// Rewrites (or adds) the `tools` line to the allowed tools minus the OMP tools matching Claude's `disallowed`.
function allowTools(lines: string[], disallowed: string[]) {
  const denied = new Set(
    disallowed.flatMap((tool) => {
      const name = tool.trim().toLowerCase();
      return name ? (claudeToolsInOmp[name] ?? [name]) : [];
    }),
  );
  const index = lines.findIndex((line) => /^tools:/.test(line));
  const allowed =
    index >= 0
      ? lines[index]
          .replace(/^tools:/, '')
          .split(',')
          .map((tool) => tool.trim().toLowerCase())
          .filter(Boolean)
      : ompSubagentTools;
  const line = `tools: ${allowed.filter((tool) => !denied.has(tool)).join(', ')}`;
  if (index >= 0) lines[index] = line;
  else lines.push(line);
}

// The built-in tools a Claude Code subagent gets by default, by their OMP names.
const ompSubagentTools = [
  'read',
  'bash',
  'edit',
  'write',
  'ast_edit',
  'grep',
  'glob',
  'find',
  'lsp',
  'eval',
  'debug',
  'web_search',
  'todo',
];

const claudeToolsInOmp: Record<string, string[]> = {
  edit: ['edit', 'ast_edit'],
  multiedit: ['edit', 'ast_edit'],
  notebookedit: ['edit'],
  websearch: ['web_search'],
  // OMP's read also fetches URLs; denying WebFetch must not deny file reads.
  webfetch: [],
  todowrite: ['todo'],
};

const textSkillExtensions = new Set([
  '.js',
  '.json',
  '.md',
  '.mdx',
  '.mjs',
  '.txt',
  '.ts',
  '.yaml',
  '.yml',
]);

function isTextSkillFile(file: string) {
  return textSkillExtensions.has(extname(file));
}

function projectOmpSkillRoot(cwd: string) {
  return join(projectRoot(cwd), '.omp', 'skills', 'impeccable');
}

function projectAgentsSkillRoot(cwd: string) {
  return join(projectRoot(cwd), '.agents', 'skills', 'impeccable');
}

function isSkillRoot(dir: string) {
  return existsSync(join(dir, 'SKILL.md')) && existsSync(join(dir, 'scripts'));
}

function projectRoot(cwd: string) {
  let dir = resolve(cwd);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return resolve(cwd);
}

function resolveImpeccableCli() {
  try {
    let current = dirname(require.resolve('impeccable'));
    while (current !== dirname(current)) {
      const candidate = join(current, 'package.json');
      if (existsSync(candidate)) {
        const cli = join(current, 'cli', 'bin', 'cli.js');
        if (existsSync(cli)) return cli;
      }
      current = dirname(current);
    }
  } catch {
    /* dependency absent in local dev; use npx */
  }
  return null;
}

function runImpeccable(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
) {
  const cli = resolveImpeccableCli();
  return cli
    ? runProcess(process.execPath, [cli, ...args], cwd, signal, timeoutMs)
    : runProcess(
        'npx',
        ['-y', 'impeccable@latest', ...args],
        cwd,
        signal,
        timeoutMs,
      );
}

function runLauncher(
  skillRoot: string,
  verb: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
  input?: string,
) {
  return runProcess(
    join(skillRoot, 'scripts', 'impeccable'),
    [verb, ...args],
    cwd,
    signal,
    timeoutMs,
    input,
  );
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
  input?: string,
) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolvePromise) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Compiled omp binaries are process.execPath; BUN_BE_BUN makes them run scripts as Bun.
        env:
          command === process.execPath && process.versions.bun
            ? { ...process.env, BUN_BE_BUN: '1' }
            : process.env,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      // A child that exits before reading stdin raises EPIPE here; its exit code is what matters.
      child.stdin.on('error', () => {});
      child.stdin.end(input ?? '');
      child.on('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolvePromise({ stdout, stderr: stderr || error.message, code: 1 });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolvePromise({ stdout, stderr, code });
      });
    },
  );
}

function parseJson(output: string): unknown {
  const text = output.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* try extracting a JSON object below */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* not a JSON object */
    }
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* try previous line */
    }
  }
  return null;
}

function asLiveEvent(value: unknown): LiveEventData | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as { type?: unknown };
  if (typeof event.type !== 'string') return undefined;
  return value as LiveEventData;
}

// Types and static data.
const require = createRequire(import.meta.url);

type Delivery = 'steer' | 'followUp' | 'aside';

type LiveState = {
  active: boolean;
  cwd?: string;
  skillRoot?: string;
  delivery: Delivery;
  poll?: ChildProcessByStdio<null, Readable, Readable>;
  pausedFor?: string;
  lastEvent?: LiveEventData;
};

type LiveEventData = {
  type: string;
  id?: string;
  action?: string;
  _acceptResult?: { carbonize?: boolean };
  _completionAck?: { ok?: boolean };
  [key: string]: unknown;
};

// What `impeccable live` prints, as far as the extension reads it.
type LiveBoot = {
  ok?: boolean;
  serverPort?: number;
  serverToken?: string;
  projectRoot?: string;
  targetPath?: string | null;
  liveConfigPath?: string;
  roots?: { sessionRoot?: string | null };
  configCreated?: boolean;
  devUrl?: string | null;
  pageUrls?: string[];
  devCommand?: string;
  contextMissing?: string[];
  configDrift?: { orphans?: unknown[]; hint?: unknown } | null;
  _instructions?: string;
};

// Upstream crates/live/src/live_poll.rs EVENT_TYPES_NEEDING_AGENT_REPLY.
const agentReplyEvents = new Set([
  'generate',
  'steer',
  'manual_edit_apply',
  'carbonize_cleanup',
  'variant_mount_failed',
]);
