import type { ExtensionTheme } from '@oh-my-pi/pi-coding-agent/extensibility/extensions/render-types';
import type {
  AgentToolResult,
  ToolRenderResultOptions,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import { UiNode } from '@oh-my-pi/pi-tui/node';
import { describe, expect, test } from 'vitest';

import {
  type LauncherDetails,
  type LiveCompleteArgs,
  type LiveReplyArgs,
  liveCompleteCard,
  liveReplyCard,
} from '../extensions/tool-cards.tsx';

const GLYPHS: Record<string, string> = {
  'status.success': 'OK',
  'status.warning': 'WARN',
  'status.aborted': 'ABORT',
  'status.pending': 'WAIT',
};
const theme = {
  symbols: { symbol: (key: string) => GLYPHS[key] ?? '' },
} as unknown as ExtensionTheme;

const collapsed: ToolRenderResultOptions = {
  expanded: false,
  isPartial: false,
};
const expanded: ToolRenderResultOptions = { expanded: true, isPartial: false };

interface Span {
  t: string;
  s?: string;
}

function asNode(render: unknown): UiNode {
  expect(render).toBeInstanceOf(UiNode);
  return render as UiNode;
}

function walk(node: UiNode, visit: (node: UiNode) => void): void {
  visit(node);
  for (const child of node.children()) walk(child, visit);
}

function spansOf(node: UiNode): Span[] {
  const props = node.props() as { spans?: Span[]; text?: string };
  return props.spans ?? (props.text ? [{ t: props.text }] : []);
}

/** Text rows of a card: one string per text node, one per kv fact. */
function rows(render: unknown): string[] {
  const out: string[] = [];
  walk(asNode(render), (node) => {
    if (node.kind === 'text')
      out.push(
        spansOf(node)
          .map((s) => s.t)
          .join(''),
      );
    if (node.kind === 'kv') {
      const { items } = node.props() as {
        items: { k: string; v: Span[] }[];
      };
      for (const item of items)
        out.push(`${item.k}: ${item.v.map((s) => s.t).join('')}`);
    }
  });
  return out;
}

function spanFor(render: unknown, text: string): Span | undefined {
  let found: Span | undefined;
  walk(asNode(render), (node) => {
    if (node.kind !== 'text') return;
    found ??= spansOf(node).find((s) => s.t.includes(text));
  });
  return found;
}

function ok(stdout: string, stderr = ''): AgentToolResult<LauncherDetails> {
  return {
    content: [{ type: 'text', text: 'done' }],
    details: { stdout, stderr, code: 0 },
  };
}

const replyAck = (extra: object = {}) =>
  JSON.stringify({
    ok: true,
    id: 'ab12cd34',
    status: 'done',
    _instructions: 'Poll again now.',
    ...extra,
  });

function reply(
  result: AgentToolResult<LauncherDetails>,
  args?: LiveReplyArgs,
  options = collapsed,
) {
  return liveReplyCard.renderResult(result, options, theme, args);
}

function complete(
  result: AgentToolResult<LauncherDetails>,
  args?: LiveCompleteArgs,
  options = collapsed,
) {
  return liveCompleteCard.renderResult(result, options, theme, args);
}

describe('impeccable_live_reply card', () => {
  test('leads with a success line naming id, status and resumed polling, file shown, ack noise dropped', () => {
    const card = reply(ok(replyAck({ file: 'src/pricing.html' })), {
      id: 'ab12cd34',
      status: 'done',
      file: 'src/pricing.html',
    });
    const [head, ...rest] = rows(card);

    expect(head).toContain('OK');
    expect(head).toContain('ab12cd34');
    expect(head).toContain('done');
    expect(head).toContain('polling resumed');
    expect(rest).toContain('file: src/pricing.html');
    expect(rows(card).join('\n')).not.toMatch(/Poll again|_instructions|"ok"/);
    expect(spanFor(card, 'OK')?.s).toBe('success');
  });

  test('an error-status reply is a warning and keeps the reason', () => {
    const card = reply(ok(replyAck({ status: 'error' })), {
      id: 'ab12cd34',
      status: 'error',
      message: 'Variant failed to mount',
    });

    expect(spanFor(card, 'WARN')?.s).toBe('warning');
    expect(rows(card)).toContain('reason: Variant failed to mount');
  });

  test('a message on a normal reply shows as a note', () => {
    const card = reply(ok(replyAck({ status: 'steer_done' })), {
      id: 'ab12cd34',
      status: 'steer_done',
      message: 'Tightened spacing',
    });

    expect(rows(card)).toContain('note: Tightened spacing');
  });

  test('launcher facts come from stdout when args are missing', () => {
    const [head] = rows(reply(ok(replyAck({ status: 'partial' }))));

    expect(head).toContain('ab12cd34');
    expect(head).toContain('partial');
  });

  test('unparseable stdout is shown as raw lines and capped while collapsed', () => {
    const stdout = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const args: LiveReplyArgs = { id: 'ab12cd34', status: 'done' };

    const short = rows(reply(ok(stdout), args));
    expect(short).toContain('line 0');
    expect(short).not.toContain('line 9');
    expect(short.at(-1)).toBe('… 6 more lines');

    const full = rows(reply(ok(stdout), args, expanded));
    expect(full).toContain('line 9');
    expect(full.join('\n')).not.toContain('more line');
  });

  test('stderr is shown, capped while collapsed', () => {
    const stderr = Array.from({ length: 6 }, (_, i) => `warn ${i}`).join('\n');
    const short = rows(reply(ok(replyAck(), stderr)));

    expect(short).toContain('warn 0');
    expect(short).not.toContain('warn 5');
    expect(short.at(-1)).toBe('… 2 more lines');
  });

  test('terminal escapes in launcher output are stripped', () => {
    const esc = String.fromCharCode(27);
    const text = rows(
      reply(ok(replyAck(), `${esc}[31mred${esc}[0m note`)),
    ).join('\n');

    expect(text).toContain('red note');
    expect(text).not.toContain(esc);
  });

  test.each([
    ['an error result', { ...ok(replyAck()), isError: true }],
    ['no details', { content: [], details: undefined }],
    [
      'a non-zero exit',
      { content: [], details: { stdout: replyAck(), stderr: '', code: 1 } },
    ],
    [
      'a null exit code',
      { content: [], details: { stdout: replyAck(), stderr: '', code: null } },
    ],
    [
      'a refused reply',
      ok(JSON.stringify({ ok: false, error: 'unknown_poll_reply_id' })),
    ],
    ['details of another shape', { content: [], details: { foo: 1 } }],
    ['no id anywhere', ok('not json')],
  ])('throws on %s so the generic card shows', (_name, result) => {
    expect(() => reply(result as AgentToolResult<LauncherDetails>)).toThrow();
  });

  test('the call row appears only while pending', () => {
    const args: LiveReplyArgs = { id: 'ab12cd34', status: 'done' };

    expect(
      liveReplyCard.renderCall(
        args,
        { expanded: false, isPartial: true },
        theme,
      ),
    ).toBeDefined();
    expect(liveReplyCard.renderCall(args, collapsed, theme)).toBeUndefined();
  });
});

describe('impeccable_live_complete card', () => {
  const completeOut = (phase: string, snapshot: object = {}) =>
    JSON.stringify(
      { ok: true, id: 'ab12cd34', phase, snapshot: { phase, ...snapshot } },
      null,
      2,
    );

  test('completion is a success line with the accepted file', () => {
    const card = complete(
      ok(completeOut('completed', { sourceFile: 'src/pricing.html' })),
      { id: 'ab12cd34' },
    );
    const [head, ...rest] = rows(card);

    expect(head).toContain('Completed');
    expect(head).toContain('ab12cd34');
    expect(head).toContain('polling resumed');
    expect(head).not.toContain('forced');
    expect(rest).toEqual(['file: src/pricing.html']);
    expect(spanFor(card, 'OK')?.s).toBe('success');
  });

  test('discarded, forced and failed completions read differently', () => {
    const discarded = complete(ok(completeOut('discarded')), {
      id: 'ab12cd34',
      discarded: true,
    });
    const forced = complete(ok(completeOut('completed')), {
      id: 'ab12cd34',
      force: true,
    });
    const failed = complete(
      ok(completeOut('agent_error', { message: 'Cleanup impossible' })),
      { id: 'ab12cd34', error: 'Cleanup impossible' },
    );

    expect(rows(discarded)[0]).toContain('Discarded');
    expect(spanFor(discarded, 'ABORT')?.s).toBe('muted');

    expect(rows(forced)[0]).toContain('Completed');
    expect(rows(forced)[0]).toContain('forced');
    expect(spanFor(forced, 'WARN')?.s).toBe('warning');

    expect(rows(failed)[0]).toContain('failure');
    expect(rows(failed)).toContain('reason: Cleanup impossible');
    expect(spanFor(failed, 'WARN')?.s).toBe('warning');
  });

  test('force on a discard does not claim the source check was bypassed', () => {
    const card = complete(ok(completeOut('discarded')), {
      id: 'ab12cd34',
      discarded: true,
      force: true,
    });

    expect(rows(card)[0]).not.toContain('forced');
  });

  test('snapshot details are capped while collapsed and complete when expanded', () => {
    const generationTimings = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`step${i}`, i]),
    );
    const result = ok(completeOut('completed', { generationTimings }));

    const short = rows(complete(result, { id: 'ab12cd34' }));
    expect(short.some((row) => /^… \d+ more lines$/.test(row))).toBe(true);
    expect(short.join('\n')).not.toContain('step7');

    const full = rows(complete(result, { id: 'ab12cd34' }, expanded)).join(
      '\n',
    );
    expect(full).toContain('step7');
    expect(full).not.toContain('more line');
  });

  test.each([
    ['an error result', { ...ok(completeOut('completed')), isError: true }],
    ['no details', { content: [], details: undefined }],
    [
      'a refused completion',
      ok(JSON.stringify({ ok: false, error: 'source_dirty' })),
    ],
    [
      'a non-zero exit',
      {
        content: [],
        details: { stdout: completeOut('completed'), stderr: '', code: 1 },
      },
    ],
    ['no id anywhere', ok('garbage')],
  ])('throws on %s so the generic card shows', (_name, result) => {
    expect(() =>
      complete(result as AgentToolResult<LauncherDetails>),
    ).toThrow();
  });

  test('the call row appears only while pending', () => {
    const args: LiveCompleteArgs = { id: 'ab12cd34' };

    expect(
      liveCompleteCard.renderCall(
        args,
        { expanded: false, isPartial: true },
        theme,
      ),
    ).toBeDefined();
    expect(liveCompleteCard.renderCall(args, collapsed, theme)).toBeUndefined();
  });
});
