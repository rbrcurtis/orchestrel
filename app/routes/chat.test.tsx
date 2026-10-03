// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '~/stores/context';
import { RootStore } from '~/stores/root-store';
import ChatLayout from './chat';

const stores: RootStore[] = [];

// The store opens a real socket.io connection with endless reconnection, so a test's
// client outlives the test. Left alone, those retries keep logging `[ws] connect error`
// under later tests and one can land after the file finishes, which closes the worker
// with a pending console RPC (EnvironmentTeardownError) and a non-zero suite exit.
afterEach(() => {
  for (const store of stores) store.ws.dispose();
  stores.length = 0;
});

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
});

function renderChatLayout() {
  const store = new RootStore();
  stores.push(store);
  store.subscribe = vi.fn();

  render(
    <StoreProvider store={store}>
      <MemoryRouter initialEntries={['/chat']}>
        <Routes>
          <Route path="/chat" element={<ChatLayout />}>
            <Route index element={<div>Chat home</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </StoreProvider>,
  );
}

describe('ChatLayout header', () => {
  it('shows the chat title and new session action without chat nav or settings', () => {
    renderChatLayout();

    expect(screen.getByRole('heading', { name: 'Orchestrel Chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Session' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Chat' })).toBeNull();
    expect(screen.queryByTitle('Settings')).toBeNull();
  });
});
