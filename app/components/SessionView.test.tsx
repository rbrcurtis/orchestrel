// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionView } from './SessionView';
import type { Card } from '../../src/shared/ws-protocol';

const sessionStore = {
  getSession: vi.fn(),
  loadHistory: vi.fn(),
  requestStatus: vi.fn(),
  sendMessage: vi.fn(),
  stopSession: vi.fn(),
  compactSession: vi.fn(),
  stoppingCards: new Set<number>(),
};

const cardStore = {
  getCard: vi.fn(),
  updateCard: vi.fn(),
};

const configStore = {
  allProviders: [['chatgpt', { label: 'ChatGPT' }]],
  getModels: vi.fn(() => [['gpt-5.5', { label: 'GPT 5.5' }]]),
};

const store = {
  ws: {
    connected: true,
    forceReconnect: vi.fn(),
  },
};

vi.mock('~/stores/context', () => ({
  useSessionStore: () => sessionStore,
  useCardStore: () => cardStore,
  useConfigStore: () => configStore,
  useStore: () => store,
}));

vi.mock('./ContextGauge', () => ({
  ContextGauge: ({ percent }: { percent: number }) => <div data-testid="context-percent">{percent}</div>,
}));

vi.mock('./SubagentFeed', () => ({
  SubagentFeed: () => null,
}));

vi.mock('./LazyTranscript', () => ({
  LazyTranscript: () => null,
}));

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() { /* test no-op */ }
    unobserve() { /* test no-op */ }
    disconnect() { /* test no-op */ }
  };
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  sessionStore.stoppingCards = new Set<number>();
  store.ws.connected = true;
  store.ws.forceReconnect = vi.fn();
  configStore.getModels.mockReturnValue([['gpt-5.5', { label: 'GPT 5.5' }]]);
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
    summarizeThreshold: 0.6,
    promptsSent: 1,
    turnsCompleted: 1,
    contextTokens,
    contextWindow,
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T19:59:44.564Z',
  };
}

function setDefaultState(overrides?: {
  card?: Partial<Card>;
  session?: Record<string, unknown> | undefined;
}) {
  const card = { ...makeCard(139030, 200000), ...overrides?.card };
  cardStore.getCard.mockReturnValue(card);

  if (overrides?.session === undefined) {
    sessionStore.getSession.mockReturnValue(undefined);
    return;
  }

  sessionStore.getSession.mockReturnValue({
    active: false,
    status: 'completed',
    sessionId: '8622c811-8f13-4b6e-9046-552a33ce879b',
    promptsSent: 1,
    turnsCompleted: 1,
    accumulator: {
      conversation: [],
      currentBlocks: [],
      subagents: new Map(),
      retryAfterMs: null,
    },
    historyLoaded: true,
    contextTokens: 139030,
    contextWindow: 200000,
    bgcInProgress: false,
    ...overrides?.session,
  });
}

function renderSessionView(props?: Partial<React.ComponentProps<typeof SessionView>>) {
  return render(
    <SessionView
      cardId={1011}
      sessionId="8622c811-8f13-4b6e-9046-552a33ce879b"
      model="gpt-5.5"
      providerID="chatgpt"
      summarizeThreshold={0.7}
      {...props}
    />,
  );
}

describe('SessionView context percent', () => {
  it('uses the full context window as the denominator', () => {
    setDefaultState({
      session: {
        contextTokens: 139030,
        contextWindow: 200000,
      },
    });

    renderSessionView();

    expect(Number(screen.getByTestId('context-percent').textContent)).toBeCloseTo(69.515);
  });

  it('uses session context tokens even when they are zero', () => {
    setDefaultState({
      card: { contextTokens: 50000, contextWindow: 200000 },
      session: {
        contextTokens: 0,
        contextWindow: 200000,
      },
    });

    renderSessionView();

    expect(Number(screen.getByTestId('context-percent').textContent)).toBe(0);
  });

  it('clamps context percent at 100', () => {
    setDefaultState({
      session: {
        contextTokens: 250000,
        contextWindow: 200000,
      },
    });

    renderSessionView();

    expect(Number(screen.getByTestId('context-percent').textContent)).toBe(100);
  });
});

describe('SessionView prompt submission', () => {
  it('calls onPromptSent after a successful send', async () => {
    setDefaultState({
      card: { sessionId: null },
      session: undefined,
    });
    sessionStore.sendMessage.mockResolvedValue(undefined);
    const onPromptSent = vi.fn();

    renderSessionView({
      sessionId: null,
      onPromptSent,
    });

    fireEvent.change(screen.getByPlaceholderText('Enter a prompt to start a session...'), {
      target: { value: 'Run the ferris wheel' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText('Enter a prompt to start a session...'), {
      key: 'Enter',
    });

    await waitFor(() => {
      expect(sessionStore.sendMessage).toHaveBeenCalledWith(1011, 'Run the ferris wheel', undefined);
      expect(onPromptSent).toHaveBeenCalledTimes(1);
    });
  });

  it('does not call onPromptSent when send fails', async () => {
    setDefaultState({
      card: { sessionId: null },
      session: undefined,
    });
    sessionStore.sendMessage.mockRejectedValue(new Error('send failed'));
    const onPromptSent = vi.fn();

    renderSessionView({
      sessionId: null,
      onPromptSent,
    });

    fireEvent.change(screen.getByPlaceholderText('Enter a prompt to start a session...'), {
      target: { value: 'Run the ferris wheel' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText('Enter a prompt to start a session...'), {
      key: 'Enter',
    });

    await waitFor(() => {
      expect(sessionStore.sendMessage).toHaveBeenCalledWith(1011, 'Run the ferris wheel', undefined);
    });
    expect(onPromptSent).not.toHaveBeenCalled();
  });

  it('focuses the prompt textarea when promptFocusSeq changes', async () => {
    setDefaultState();

    const { rerender } = renderSessionView({ promptFocusSeq: 1 });
    const textarea = screen.getByPlaceholderText('Enter a prompt to start a session...');

    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });

    rerender(
      <SessionView
        cardId={1011}
        sessionId="8622c811-8f13-4b6e-9046-552a33ce879b"
        model="gpt-5.5"
        providerID="chatgpt"
        summarizeThreshold={0.7}
        promptFocusSeq={2}
      />,
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });
});
