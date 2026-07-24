// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageBlock } from './MessageBlock';
import { ContentBlock, type ConversationEntry } from '~/lib/message-accumulator';

function renderEntry(entry: ConversationEntry) {
  return renderToStaticMarkup(<MessageBlock entry={entry} index={0} />);
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/gu, ' ').trim();
}

function expectedTimestampParts(timestamp: number) {
  const parts = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(new Date(timestamp));

  const formatted = normalizeWhitespace(parts.map((part) => part.value).join(''));
  const dateTokens = parts
    .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
    .map((part) => part.value.trim())
    .filter(Boolean);
  const timeTokens = parts
    .filter((part) => part.type === 'hour' || part.type === 'minute' || part.type === 'dayPeriod')
    .map((part) => part.value.trim())
    .filter(Boolean);

  return { formatted, dateTokens, timeTokens };
}

function expectDateAndTimeTokens(html: string, dateTokens: string[], timeTokens: string[]) {
  for (const token of dateTokens) expect(html).toContain(token);
  for (const token of timeTokens) expect(html).toContain(token);
}

describe('MessageBlock copy button alignment', () => {
  it('renders agent text copy button in a top-aligned row instead of absolutely positioning it', () => {
    const html = renderEntry({
      kind: 'blocks',
      blocks: [new ContentBlock({ type: 'text', content: 'Agent reply', complete: true })],
    });

    expect(html).toContain('self-start');
    expect(html).toContain('flex');
    expect(html).toContain('items-start');
    expect(html).not.toContain('absolute top-2.5 right-1');
  });

  it('renders user message copy button in a top-aligned row instead of absolutely positioning it', () => {
    const html = renderEntry({ kind: 'user', content: 'User prompt' });

    expect(html).toContain('self-start');
    expect(html).toContain('flex');
    expect(html).toContain('items-start');
    expect(html).not.toContain('absolute top-2.5 right-1');
  });
});

describe('MessageBlock timestamp formatting', () => {
  const timestamp = Date.UTC(2026, 3, 23, 16, 6, 0);
  const { formatted, dateTokens, timeTokens } = expectedTimestampParts(timestamp);

  it('shows date and time on session start markers', () => {
    const html = renderEntry({ kind: 'system', subtype: 'init', model: 'claude-sonnet-4-5', timestamp });
    const normalizedHtml = normalizeWhitespace(html);

    expect(normalizedHtml).toContain(normalizeWhitespace(`Session started · claude-sonnet-4-5 · ${formatted}`));
    expectDateAndTimeTokens(html, dateTokens, timeTokens);
  });

  it('shows date and time on turn completion markers', () => {
    const html = renderEntry({
      kind: 'result',
      timestamp,
      data: {
        subtype: 'success',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        numTurns: 1,
        durationMs: 0,
      },
    });
    const normalizedHtml = normalizeWhitespace(html);

    expect(normalizedHtml).toContain(normalizeWhitespace(`Turn complete · ${formatted}`));
    expectDateAndTimeTokens(html, dateTokens, timeTokens);
  });

  it('shows date and time on context compacted markers', () => {
    const html = renderEntry({ kind: 'compact', timestamp });
    const normalizedHtml = normalizeWhitespace(html);

    expect(normalizedHtml).toContain(normalizeWhitespace(`Context compacted · ${formatted}`));
    expectDateAndTimeTokens(html, dateTokens, timeTokens);
  });

  it('shows custom labels on compact markers', () => {
    const html = renderEntry({ kind: 'compact', label: 'Background compaction started', timestamp });
    const normalizedHtml = normalizeWhitespace(html);

    expect(normalizedHtml).toContain(normalizeWhitespace(`Background compaction started · ${formatted}`));
    expectDateAndTimeTokens(html, dateTokens, timeTokens);
  });
});

describe('MessageBlock user prompt rendering', () => {
  it('renders slash commands as plain user text', () => {
    const html = renderEntry({ kind: 'user', content: '/ask hello' });

    expect(html).toContain('/ask hello');
    expect(html).not.toContain('text-neon-cyan');
  });

  it('collapses multiline user prompts to their first line by default', () => {
    render(
      <MessageBlock
        entry={{ kind: 'user', content: 'Build the launchpad\nInclude deployment automation' }}
        index={0}
      />,
    );

    expect(screen.getByText('Build the launchpad')).toBeTruthy();
    expect(screen.queryByText('Include deployment automation')).toBeNull();

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText(/Include deployment automation/)).toBeTruthy();
  });

  it('keeps single-line user prompts fully visible without an expand control', () => {
    render(<MessageBlock entry={{ kind: 'user', content: 'Ship it' }} index={0} />);

    expect(screen.getByText('Ship it')).toBeTruthy();
    expect(screen.queryByRole('button', { expanded: false })).toBeNull();
  });
});

describe('MessageBlock code block rendering', () => {
  function renderCode(content: string) {
    return renderEntry({
      kind: 'blocks',
      blocks: [new ContentBlock({ type: 'text', content, complete: true })],
    });
  }

  it('renders a fenced code block without a language as a non-wrapping block, preserving newlines', () => {
    const html = renderCode('```\n┌──────┐\n│ node │ ──► server\n└──────┘\n```');

    // Block, not inline: rendered inside a <pre> with no-wrap whitespace
    expect(html).toContain('<pre');
    expect(html).toContain('whitespace-pre');
    expect(html).not.toContain('whitespace-pre-wrap');
    // Newlines / alignment preserved
    expect(html).toContain('┌──────┐');
    expect(html).toContain('└──────┘');
  });

  it('renders language-tagged and language-less fences identically (no language detection)', () => {
    const withLang = renderCode('```ts\nconst x = 1;\n```');
    const withoutLang = renderCode('```\nconst x = 1;\n```');

    // Both go through the same `pre` path: non-wrapping block, same wrapper markup
    for (const html of [withLang, withoutLang]) {
      expect(html).toContain('<pre');
      expect(html).toContain('whitespace-pre');
      expect(html).not.toContain('whitespace-pre-wrap');
      expect(html).toContain('const x = 1;');
    }
  });
});

describe('MessageBlock tool rendering', () => {
  it('collapses Bash cells to the first command line by default', () => {
    render(
      <MessageBlock
        entry={{
          kind: 'blocks',
          blocks: [
            new ContentBlock({
              type: 'tool_use',
              content: 'Bash',
              id: 'call_bash',
              name: 'Bash',
              input: JSON.stringify({ command: 'echo first\necho second' }),
              output: 'first\nsecond',
              complete: true,
            }),
          ],
        }}
        index={0}
      />,
    );

    expect(screen.getByText('echo first')).toBeTruthy();
    expect(screen.queryByText('echo second')).toBeNull();
    expect(screen.queryByText('first\nsecond')).toBeNull();

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText((_, el) => el?.textContent === 'echo first\necho second')).toBeTruthy();
    expect(screen.getByText((_, el) => el?.textContent === 'first\nsecond')).toBeTruthy();
  });

  it('renders tool input and output with matching text style in a 400px scroll area', () => {
    render(
      <MessageBlock
        entry={{
          kind: 'blocks',
          blocks: [
            new ContentBlock({
              type: 'tool_use',
              content: 'Read',
              id: 'call_read',
              name: 'Read',
              input: '{"file_path":"/tmp/example.txt"}',
              output: 'file contents',
              complete: true,
            }),
          ],
        }}
        index={0}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Read/ }));

    expect(screen.getByText('Input')).toBeTruthy();
    expect(screen.getByText('Output')).toBeTruthy();
    const output = screen.getByText('file contents');
    expect(output.className).toBe('text-xs font-mono whitespace-pre-wrap break-all text-foreground min-w-0');
    const viewport = output.closest('[data-slot="scroll-area-viewport"]');
    expect(viewport?.className).toContain('max-h-[400px]');
    expect(viewport?.className).not.toContain('min-h');
    expect(viewport?.className.split(' ')).not.toContain('h-[400px]');
  });
});
