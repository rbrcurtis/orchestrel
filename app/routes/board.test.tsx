// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '~/stores/context';
import { RootStore } from '~/stores/root-store';
import BoardLayout from './board';
import type { Card, Project } from '../../src/shared/ws-protocol';

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(min-width: 1024px)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  class FakeResizeObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(_callback?: ResizeObserverCallback) {}
  }
  (globalThis as unknown as { ResizeObserver: { new (callback?: ResizeObserverCallback): FakeResizeObserver } }).ResizeObserver =
    FakeResizeObserver;
  // jsdom has no scroll implementation — SessionView's transcript scroller calls it
  Element.prototype.scrollTo = vi.fn();

  localStorage.clear();
});

function makeProject(id: number, name: string): Project {
  return {
    id,
    name,
    path: `/tmp/${name.toLowerCase().replace(/\s+/g, '-')}`,
    setupCommands: '',
    isGitRepo: true,
    defaultBranch: 'main',
    defaultWorktree: false,
    defaultSandbox: false,
    defaultModel: 'sonnet',
    defaultThinkingLevel: 'high',
    providerID: 'anthropic',
    nodeName: 'local',
    color: '#f00',
    createdAt: '2026-04-24T00:00:00.000Z',
    archived: false,
  } as unknown as Project;
}

function makeCard(): Card {
  return {
    id: 7,
    title: 'Saved card',
    description: 'saved description',
    column: 'backlog',
    position: 0,
    projectId: 42,
    prUrl: null,
    sessionId: null,
    worktreeBranch: null,
    sandbox: false,
    sourceBranch: null,
    model: 'sonnet',
    provider: 'anthropic',
    nodeName: 'local',
    thinkingLevel: 'high',
    summarizeThreshold: 0.6,
    promptsSent: 0,
    turnsCompleted: 0,
    contextTokens: 0,
    contextWindow: 200000,
    createdAt: '2026-04-24T00:00:00.000Z',
    updatedAt: '2026-04-24T00:00:00.000Z',
  };
}

function providerConfig() {
  return {
    anthropic: {
      label: 'Anthropic',
      models: { sonnet: { label: 'Sonnet', modelID: 'claude-sonnet', contextWindow: 200000 } },
    },
  };
}

function renderBoard(opts?: { openSavedCard?: boolean }) {
  const store = new RootStore();
  store.subscribe = vi.fn();
  // No real server in tests — stub emit so mounted SessionViews don't open a socket
  (store.ws as unknown as { emit: (e: string, d: unknown) => Promise<unknown> }).emit = vi
    .fn()
    .mockResolvedValue(undefined);
  store.projects.hydrate([makeProject(42, 'Orchestrel')]);
  store.config.hydrateNodes([{ name: 'local', connected: true, providers: providerConfig() }]);

  if (opts?.openSavedCard) {
    store.cards.hydrate([makeCard()], true);
    localStorage.setItem('dispatcher-slots', JSON.stringify([{ type: 'manual', cardId: 7 }]));
  }

  render(
    <StoreProvider store={store}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<BoardLayout />} />
          <Route path="*" element={<div />} />
        </Routes>
      </MemoryRouter>
    </StoreProvider>,
  );

  return { store };
}

function keyDown(target: EventTarget, init: KeyboardEventInit) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

describe('Board new card shortcuts', () => {
  it('opens new card panel with Cmd+N and prevents the browser new-window default', () => {
    renderBoard();

    const e = keyDown(document.body, { key: 'n', metaKey: true });

    expect(e.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('opens new card panel with Ctrl+N and prevents the browser new-window default', () => {
    renderBoard();

    const e = keyDown(document.body, { key: 'n', ctrlKey: true });

    expect(e.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('ignores key repeat for Cmd+N', () => {
    renderBoard();

    keyDown(document.body, { key: 'n', metaKey: true });
    const repeat = keyDown(document.body, { key: 'n', metaKey: true, repeat: true });

    expect(repeat.defaultPrevented).toBe(false);
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
  });

  it('opens new card panel from a closed new-card state when focus is already in an editor field', () => {
    renderBoard({ openSavedCard: true });
    const editor = screen.getByPlaceholderText('Add a description...');
    editor.focus();

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

    const e = keyDown(editor, { key: 'n', metaKey: true });

    expect(e.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('does not hijack slash while focus is in an editor field', () => {
    renderBoard({ openSavedCard: true });
    const editor = screen.getByPlaceholderText('Add a description...');
    editor.focus();

    const e = keyDown(editor, { key: '/' });

    expect(e.defaultPrevented).toBe(false);
    expect(editor).toBe(document.activeElement);
  });
});

function reviewCard(id: number, updatedAt: string): Card {
  return { ...makeCard(), id, title: `Card ${id}`, column: 'review', updatedAt, sessionId: `sess-${id}` };
}

describe('ferris wheel prompt focus', () => {
  it('focuses the new card prompt when the hotseat rotates after a send', async () => {
    const { store } = renderBoard();

    act(() => {
      store.cards.hydrate(
        [reviewCard(1, '2026-04-24T00:00:00.000Z'), reviewCard(2, '2026-04-25T00:00:00.000Z')],
        true,
      );
    });

    const textarea = await screen.findByPlaceholderText('Enter a prompt to start a session...');
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(screen.getByText('Card 1')).toBeTruthy();

    // Sending blurs the prompt — that releases the focus lock so the wheel can turn
    fireEvent.blur(textarea);

    // The sent card moves review → running; the wheel rotates to the next review card
    act(() => {
      store.cards.hydrate(
        [{ ...reviewCard(1, '2026-04-24T00:00:00.000Z'), column: 'running' }, reviewCard(2, '2026-04-25T00:00:00.000Z')],
        true,
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Card 2')).toBeTruthy();
      expect(screen.queryByText('Card 1')).toBeNull();
      expect(document.activeElement).toBe(textarea);
    });
  });

  it('refocuses the prompt when the wheel keeps the same card', async () => {
    const { store } = renderBoard();

    act(() => {
      store.cards.hydrate([reviewCard(1, '2026-04-24T00:00:00.000Z')], true);
    });

    const textarea = await screen.findByPlaceholderText('Enter a prompt to start a session...');
    await waitFor(() => expect(document.activeElement).toBe(textarea));

    // Send via Enter — SessionView dispatches prompt-sent and blurs the prompt
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(document.activeElement).not.toBe(textarea));

    // Server echoes the card update; no other card is eligible, wheel keeps card 1
    act(() => {
      store.cards.hydrate(
        [{ ...reviewCard(1, '2026-04-24T00:00:00.000Z'), column: 'running', promptsSent: 1 }],
        true,
      );
    });

    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });
});
