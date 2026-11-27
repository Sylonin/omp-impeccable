/** @jsxRuntime classic */
/** @jsx h */
import type {
  ExtensionRender,
  ExtensionTheme,
  MessageRenderOptions,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import type { CustomMessage } from '@oh-my-pi/pi-coding-agent/session/transcript/messages';
// biome-ignore lint/correctness/noUnusedImports: the classic JSX pragma above calls h
import { h } from './jsx.ts';

export type MessageTone = 'info' | 'warning' | 'error';
export interface ImpeccableMessageDetails {
  title?: string;
  tone?: MessageTone;
}

// Help and doctor reports the user asked for show whole; only long dumps such as stderr fold.
const COLLAPSE_AFTER_LINES = 40;
const PREVIEW_LINES = 20;
// The host's own hook-message fold.
const HOOK_LINES = 5;

/** Text of a message's content, or undefined for shapes that are not plain text. */
function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (
      typeof part !== 'object' ||
      part === null ||
      part.type !== 'text' ||
      typeof part.text !== 'string'
    ) {
      return undefined;
    }
    parts.push(part.text);
  }
  return parts.join('\n');
}

interface CardSpec {
  title?: string;
  tone: MessageTone;
  text: string;
  expanded: boolean;
  /** `plain` keeps every line break and ignores Markdown; `markdown` renders it. */
  body: 'plain' | 'markdown';
  foldAfter: number;
  previewLines: number;
}

function card(spec: CardSpec): ExtensionRender {
  const { title, tone, text, expanded, body, foldAfter, previewLines } = spec;
  const foldable = text.split('\n').length > foldAfter;
  const tinted = tone !== 'info';
  const head = [
    {
      t: 'Impeccable',
      s: tinted ? `${tone} strong` : 'customMessageLabel strong',
    },
    ...(title ? [{ t: ` · ${title}`, s: tinted ? tone : 'muted' }] : []),
  ];
  return (
    <card
      head={head}
      tone={tone}
      status={tone === 'error' ? 'error' : undefined}
      collapsible={foldable}
      collapsed={foldable ? !expanded : undefined}
      preview={foldable ? { lines: previewLines } : undefined}
    >
      {body === 'markdown' ? <md text={text} /> : <ansi text={text} />}
    </card>
  );
}

export function renderImpeccableMessage(
  message: CustomMessage<ImpeccableMessageDetails | undefined>,
  options: MessageRenderOptions,
  _theme: ExtensionTheme,
): ExtensionRender | undefined {
  const text = contentText(message.content);
  if (text === undefined || text.trim() === '') return undefined;
  const { title, tone } = message.details ?? {};
  return card({
    title: typeof title === 'string' && title.trim() ? title.trim() : undefined,
    tone: tone === 'warning' || tone === 'error' ? tone : 'info',
    text,
    expanded: options.expanded,
    body: 'plain',
    foldAfter: COLLAPSE_AFTER_LINES,
    previewLines: PREVIEW_LINES,
  });
}

export function renderDesignHookMessage(
  message: CustomMessage<unknown>,
  options: MessageRenderOptions,
  _theme: ExtensionTheme,
): ExtensionRender | undefined {
  const text = contentText(message.content);
  if (text === undefined || text.trim() === '') return undefined;
  return card({
    title: 'design hook',
    tone: 'info',
    text,
    expanded: options.expanded,
    body: 'markdown',
    foldAfter: HOOK_LINES,
    previewLines: HOOK_LINES,
  });
}
