import type {
  ExtensionRender,
  ExtensionTheme,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import type { CustomMessage } from '@oh-my-pi/pi-coding-agent/session/transcript/messages';
import { UiNode } from '@oh-my-pi/pi-tui/node';
import { describe, expect, test } from 'vitest';

import {
  type ImpeccableMessageDetails,
  renderDesignHookMessage,
  renderImpeccableMessage,
} from '../extensions/message-cards.tsx';

const theme = {} as ExtensionTheme;

function message<T>(
  customType: string,
  content: CustomMessage['content'],
  details?: T,
): CustomMessage<T> {
  return {
    role: 'custom',
    customType,
    content,
    display: true,
    details,
    timestamp: 0,
  };
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
}

function draw(render: ExtensionRender | undefined): {
  card: UiNode<'card'>;
  body: UiNode<'ansi' | 'md'>;
} {
  expect(render).toBeInstanceOf(UiNode);
  const card = render as UiNode<'card'>;
  expect(card.kind).toBe('card');
  return { card, body: card.children()[0] as UiNode<'ansi' | 'md'> };
}

function headText(card: UiNode<'card'>): string {
  const head = card.props().head as readonly { t: string }[];
  return head.map((span) => span.t).join('');
}

function impeccable(
  content: CustomMessage['content'],
  details: ImpeccableMessageDetails | undefined,
  expanded = false,
) {
  return renderImpeccableMessage(
    message('impeccable', content, details),
    { expanded },
    theme,
  );
}

describe('impeccable message card', () => {
  test('heads the card with the title and keeps line breaks verbatim', () => {
    const text = 'a\n\n  b\n* c';
    const { card, body } = draw(impeccable(text, { title: 'Help' }));

    expect(headText(card)).toBe('Impeccable · Help');
    // Plain text node, not Markdown: single newlines and indentation survive.
    expect(body.kind).toBe('ansi');
    expect(body.props().text).toBe(text);
  });

  test('tone tints the card; missing or unknown details read as info', () => {
    const tones = (details: ImpeccableMessageDetails | undefined) =>
      draw(impeccable('x', details)).card.props().tone;

    expect(tones({ tone: 'error' })).toBe('error');
    expect(tones({ tone: 'warning' })).toBe('warning');
    expect(tones({})).toBe('info');
    expect(tones(undefined)).toBe('info');
    expect(tones({ tone: 'nonsense' as never })).toBe('info');
    expect(draw(impeccable('x', { tone: 'error' })).card.props().status).toBe(
      'error',
    );
    expect(headText(draw(impeccable('x', {})).card)).toBe('Impeccable');
  });

  test('short output is shown whole and not foldable', () => {
    const { card } = draw(impeccable(lines(40), {}));

    expect(card.props().collapsible).toBeFalsy();
    expect(card.props().preview).toBeUndefined();
  });

  test('long output previews while collapsed and shows fully when expanded', () => {
    const text = lines(80);
    const collapsed = draw(impeccable(text, { title: 'Update' })).card;
    const expanded = draw(impeccable(text, { title: 'Update' }, true));

    expect(collapsed.props().collapsible).toBe(true);
    expect(collapsed.props().collapsed).toBe(true);
    expect(collapsed.props().preview).toEqual({ lines: 20 });
    expect(expanded.card.props().collapsed).toBe(false);
    expect(expanded.body.props().text).toBe(text);
  });

  test('joins text parts and defers to the default card for anything else', () => {
    const joined = draw(
      impeccable(
        [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
        {},
      ),
    );
    expect(joined.body.props().text).toBe('one\ntwo');

    expect(impeccable('', {})).toBeUndefined();
    expect(impeccable('  \n ', {})).toBeUndefined();
    expect(impeccable([], {})).toBeUndefined();
    expect(
      impeccable(
        [
          { type: 'text', text: 'hi' },
          { type: 'image', data: '', mimeType: 'image/png' },
        ],
        {},
      ),
    ).toBeUndefined();
    expect(impeccable({ not: 'content' } as never, {})).toBeUndefined();
  });
});

describe('design hook message card', () => {
  const hook = (content: CustomMessage['content'], expanded = false) =>
    renderDesignHookMessage(
      message('impeccable-hook', content),
      { expanded },
      theme,
    );

  test('names the design hook and renders its note as Markdown', () => {
    const note = 'Design hook findings:\n- L3 `rule`\n\nTriage.';
    const { card, body } = draw(hook(note));

    expect(headText(card)).toBe('Impeccable · design hook');
    expect(body.kind).toBe('md');
    expect(body.props().text).toBe(note);
  });

  test('folds past five lines and unfolds when expanded', () => {
    const short = draw(hook(lines(5))).card;
    const collapsed = draw(hook(lines(6))).card;
    const expanded = draw(hook(lines(6), true)).card;

    expect(short.props().collapsible).toBeFalsy();
    expect(collapsed.props().collapsed).toBe(true);
    expect(collapsed.props().preview).toEqual({ lines: 5 });
    expect(expanded.props().collapsed).toBe(false);
  });

  test('never hides a note it cannot draw', () => {
    expect(hook('')).toBeUndefined();
    expect(hook(undefined as never)).toBeUndefined();
  });
});
