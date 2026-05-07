import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
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
