// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '~/stores/context';
import { RootStore } from '~/stores/root-store';
import { SessionView } from './SessionView';
import type { Card } from '../../src/shared/ws-protocol';

vi.mock('./ContextGauge', () => ({
  ContextGauge: ({ percent }: { percent: number }) => <div data-testid="context-percent">{percent}</div>,
}));

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() { /* test no-op */ }
    unobserve() { /* test no-op */ }
    disconnect() { /* test no-op */ }
  };
});

function makeCard(contextTokens: number, contextWindow: number): Card {
  return {
    id: 1011,
    title: 'subagent ui',
    description: '',
    column: 'review',
    position: 0,
    projectId: 1,
    prUrl: null,
    sessionId: '8622c811-8f13-4b6e-9046-552a33ce879b',
    worktreeBranch: null,
    sourceBranch: null,
    model: 'gpt-5.5',
    provider: 'chatgpt',
    thinkingLevel: 'high',
    summarizeThreshold: 0.7,
    promptsSent: 1,
    turnsCompleted: 1,
    contextTokens,
    contextWindow,
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T19:59:44.564Z',
  };
}

function renderSessionView(contextTokens: number, contextWindow: number) {
  const store = new RootStore();
  store.cards.hydrate([makeCard(contextTokens, contextWindow)], true);

  render(
    <StoreProvider store={store}>
      <SessionView
        cardId={1011}
        sessionId="8622c811-8f13-4b6e-9046-552a33ce879b"
        model="gpt-5.5"
        providerID="chatgpt"
        summarizeThreshold={0.7}
      />
    </StoreProvider>,
  );
}

describe('SessionView context percent', () => {
  it('uses the full context window as the denominator', () => {
    renderSessionView(139030, 200000);

    expect(Number(screen.getByTestId('context-percent').textContent)).toBeCloseTo(69.515);
  });

  it('clamps context percent at 100', () => {
    renderSessionView(250000, 200000);

    expect(Number(screen.getByTestId('context-percent').textContent)).toBe(100);
  });
});
