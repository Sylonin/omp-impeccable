/** @jsxRuntime classic */
/** @jsx h */
import type {
  ExtensionRender,
  ExtensionTheme,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/render-types';
import type {
  AgentToolResult,
  ToolRenderResultOptions,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import type { JSXNode } from '@oh-my-pi/pi-tui';
// biome-ignore lint/correctness/noUnusedImports: the classic JSX pragma above calls h
import { h } from './jsx.ts';

export interface LauncherDetails {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface LiveReplyArgs {
  id: string;
  status: 'done' | 'partial' | 'steer_done' | 'error';
  file?: string;
  message?: string;
  data?: unknown;
}

export interface LiveCompleteArgs {
  id: string;
  discarded?: boolean;
  error?: string;
  force?: boolean;
}

interface Span {
  t: string;
  s?: string;
}

interface Launcher {
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | undefined;
}

type Fact = { k: string; v: Span[] };

interface CardParts {
  head: Span[];
  facts: Fact[];
  extras: string[];
  stderr: string[];
}

/** Lines of launcher output shown while collapsed. */
const PREVIEW_LINES = 4;

const ANSI = new RegExp(
  `${String.fromCharCode(27)}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\))`,
  'g',
);
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal control bytes from launcher output
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function clean(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL, '').replaceAll('\t', '  ');
}

function lines(text: string): string[] {
  const out = text.split('\n').map((line) => line.trimEnd());
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The launcher result of a successful run; `undefined` for errors and unknown shapes. */
function launcherOf(
  result: AgentToolResult<LauncherDetails>,
): Launcher | undefined {
  if ('isError' in result && result.isError) return undefined;
  const d = result.details as Partial<LauncherDetails> | undefined;
  if (!d || typeof d.stdout !== 'string' || typeof d.stderr !== 'string')
    return undefined;
  if (d.code !== 0) return undefined;
  let json: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(d.stdout);
    if (isRecord(parsed)) json = parsed;
  } catch {
    // Non-JSON stdout is shown as raw lines.
  }
  return { stdout: clean(d.stdout), stderr: clean(d.stderr), json };
}

function omit(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !keys.includes(key)),
  );
}

function jsonLines(value: Record<string, unknown>): string[] {
  return Object.keys(value).length === 0
    ? []
    : lines(clean(JSON.stringify(value, null, 2)));
}

function glyph(theme: ExtensionTheme, key: string, fallback: string): string {
  return theme.symbols.symbol(key) || fallback;
}

const SEP: Span = { t: ' · ', s: 'muted' };

/** Output block: the first lines while collapsed, a count of the rest, everything expanded. */
function block(
  name: string,
  all: readonly string[],
  style: string,
  expanded: boolean,
): JSXNode[] {
  if (all.length === 0) return [];
  const shown = expanded ? all : all.slice(0, PREVIEW_LINES);
  const hidden = all.length - shown.length;
  const nodes: JSXNode[] = shown.map((line, i) => (
    <text
      key={`${name}${i}`}
      spans={[{ t: line, s: style }]}
      wrap={expanded ? 'char' : 'none'}
      truncate="end"
    />
  ));
  if (hidden > 0)
    nodes.push(
      <text
        key={`${name}-more`}
        spans={[
          { t: `… ${hidden} more line${hidden === 1 ? '' : 's'}`, s: 'muted' },
        ]}
      />,
    );
  return nodes;
}

function view(parts: CardParts, expanded: boolean): ExtensionRender {
  const children: JSXNode[] = [<text key="head" spans={parts.head} />];
  if (parts.facts.length > 0)
    children.push(<kv key="facts" items={parts.facts} />);
  children.push(...block('out', parts.extras, 'toolOutput', expanded));
  children.push(...block('err', parts.stderr, 'muted', expanded));
  return <col key="impeccable-live">{children}</col>;
}

function pendingLine(
  theme: ExtensionTheme,
  verb: string,
  id: string | undefined,
  detail: string | undefined,
): ExtensionRender {
  const spans: Span[] = [
    { t: `${glyph(theme, 'status.pending', '…')} `, s: 'muted' },
    { t: verb, s: 'toolTitle strong' },
  ];
  if (id) spans.push({ t: ` ${id}`, s: 'accent' });
  if (detail) spans.push(SEP, { t: detail, s: 'muted' });
  return <text spans={spans} />;
}

function replyParts(
  run: Launcher,
  theme: ExtensionTheme,
  args: Partial<LiveReplyArgs>,
): CardParts {
  const ack = run.json;
  if (ack?.ok === false) throw new Error('Impeccable live reply was refused');
  const id = str(ack?.id) ?? str(args.id);
  const status = str(ack?.status) ?? str(args.status);
  if (!id || !status) throw new Error('unrecognised live reply result');
  const file = str(ack?.file) ?? str(args.file);
  const message = str(args.message);
  const failed = status === 'error';
  const tone = failed ? 'warning' : 'success';
  const head: Span[] = [
    {
      t: `${glyph(theme, failed ? 'status.warning' : 'status.success', failed ? '!' : '✓')} `,
      s: tone,
    },
    { t: 'Replied to Impeccable live', s: 'toolTitle strong' },
    { t: ` ${id}`, s: 'accent' },
    SEP,
    { t: status, s: failed ? 'warning strong' : 'strong' },
    SEP,
    { t: 'polling resumed', s: 'muted' },
  ];
  const facts: Fact[] = [];
  if (file) facts.push({ k: 'file', v: [{ t: file, s: 'path' }] });
  if (message)
    facts.push({
      k: failed ? 'reason' : 'note',
      v: [{ t: message, s: failed ? 'warning' : undefined }],
    });
  const extras = ack
    ? jsonLines(omit(ack, ['ok', 'id', 'status', 'file', '_instructions']))
    : lines(run.stdout);
  return { head, facts, extras, stderr: lines(run.stderr) };
}

type Outcome = 'completed' | 'discarded' | 'error';

const PHASE_OUTCOME: Readonly<Record<string, Outcome>> = {
  completed: 'completed',
  discarded: 'discarded',
  agent_error: 'error',
};

const OUTCOME_PHASE: Readonly<Record<Outcome, string>> = {
  completed: 'completed',
  discarded: 'discarded',
  error: 'agent_error',
};

function completeParts(
  run: Launcher,
  theme: ExtensionTheme,
  args: Partial<LiveCompleteArgs>,
): CardParts {
  const body = run.json;
  if (body?.ok === false)
    throw new Error('Impeccable live complete was refused');
  const id = str(body?.id) ?? str(args.id);
  if (!id) throw new Error('unrecognised live complete result');
  const phase = str(body?.phase);
  const snapshot = isRecord(body?.snapshot) ? body.snapshot : undefined;
  const outcome: Outcome =
    (phase ? PHASE_OUTCOME[phase] : undefined) ??
    (args.error ? 'error' : args.discarded ? 'discarded' : 'completed');
  // The launcher only gates plain completion, so --force matters nowhere else.
  const forced = outcome === 'completed' && args.force === true;

  let head: Span[];
  if (outcome === 'error') {
    head = [
      { t: `${glyph(theme, 'status.warning', '!')} `, s: 'warning' },
      { t: 'Recorded live session failure', s: 'toolTitle strong' },
    ];
  } else if (outcome === 'discarded') {
    head = [
      { t: `${glyph(theme, 'status.aborted', '×')} `, s: 'muted' },
      { t: 'Discarded live session', s: 'toolTitle strong' },
    ];
  } else {
    head = [
      {
        t: `${glyph(theme, forced ? 'status.warning' : 'status.success', forced ? '!' : '✓')} `,
        s: forced ? 'warning' : 'success',
      },
      { t: 'Completed live session', s: 'toolTitle strong' },
    ];
  }
  head.push({ t: ` ${id}`, s: 'accent' });
  if (forced)
    head.push(SEP, { t: 'forced past source check', s: 'warning strong' });
  head.push(SEP, { t: 'polling resumed', s: 'muted' });

  const facts: Fact[] = [];
  const file = str(snapshot?.sourceFile);
  if (file) facts.push({ k: 'file', v: [{ t: file, s: 'path' }] });
  const reason = str(args.error) ?? str(snapshot?.message);
  if (outcome === 'error' && reason)
    facts.push({ k: 'reason', v: [{ t: reason, s: 'warning' }] });
  if (phase && phase !== OUTCOME_PHASE[outcome])
    facts.push({ k: 'phase', v: [{ t: phase }] });

  const rest: Record<string, unknown> = body
    ? omit(body, ['ok', 'id', 'phase', 'snapshot', '_instructions'])
    : {};
  const snapshotRest = snapshot
    ? omit(snapshot, ['id', 'phase', 'sourceFile', 'message'])
    : {};
  if (Object.keys(snapshotRest).length > 0) rest.snapshot = snapshotRest;
  const extras = body ? jsonLines(rest) : lines(run.stdout);
  return { head, facts, extras, stderr: lines(run.stderr) };
}

export const liveReplyCard = {
  renderCall(
    args: LiveReplyArgs,
    options: ToolRenderResultOptions,
    theme: ExtensionTheme,
  ): ExtensionRender | undefined {
    // The host draws the call row above the result; only a pending call needs one.
    if (!options.isPartial) return undefined;
    return pendingLine(
      theme,
      'Replying to Impeccable live',
      args?.id,
      args?.status,
    );
  },
  renderResult(
    result: AgentToolResult<LauncherDetails>,
    options: ToolRenderResultOptions,
    theme: ExtensionTheme,
    args?: LiveReplyArgs,
  ): ExtensionRender | undefined {
    const run = launcherOf(result);
    if (!run)
      throw new Error(
        'impeccable_live_reply failed or returned an unknown shape',
      );
    return view(replyParts(run, theme, args ?? {}), options.expanded);
  },
};

export const liveCompleteCard = {
  renderCall(
    args: LiveCompleteArgs,
    options: ToolRenderResultOptions,
    theme: ExtensionTheme,
  ): ExtensionRender | undefined {
    if (!options.isPartial) return undefined;
    return pendingLine(
      theme,
      'Completing live session',
      args?.id,
      args?.error ? 'error' : args?.discarded ? 'discarded' : undefined,
    );
  },
  renderResult(
    result: AgentToolResult<LauncherDetails>,
    options: ToolRenderResultOptions,
    theme: ExtensionTheme,
    args?: LiveCompleteArgs,
  ): ExtensionRender | undefined {
    const run = launcherOf(result);
    if (!run)
      throw new Error(
        'impeccable_live_complete failed or returned an unknown shape',
      );
    return view(completeParts(run, theme, args ?? {}), options.expanded);
  },
};
