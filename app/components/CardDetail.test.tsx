// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { StoreProvider } from '~/stores/context';
import { RootStore } from '~/stores/root-store';
import { NewCardDetail } from './CardDetail';
import type { Card, Project } from '../../src/shared/ws-protocol';

function makeProject(id: number, name: string, archived = false): Project {
  return {
    id,
    name,
    path: `/tmp/${name.toLowerCase().replace(/\s+/g, '-')}`,
    setupCommands: '',
    isGitRepo: true,
    defaultBranch: 'main',
    defaultWorktree: false,
    defaultModel: 'sonnet',
    defaultThinkingLevel: 'high',
    providerID: 'anthropic',
    color: '#f00',
    memoryBaseUrl: null,
    memoryApiKey: null,
    createdAt: '2026-04-24T00:00:00.000Z',
    archived,
  } as unknown as Project;
}

function makeCard(description: string): Card {
  return {
    id: 7,
    title: 'Saved card',
    description,
    column: 'backlog',
    position: 0,
    projectId: 42,
    prUrl: null,
    sessionId: null,
    worktreeBranch: null,
    sourceBranch: null,
    model: 'sonnet',
    provider: 'anthropic',
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

function renderNewCardDetail() {
  const store = new RootStore();
  store.projects.hydrate([makeProject(42, 'Orchestrel')]);
  store.config.hydrate({ anthropic: { label: 'Anthropic', models: { sonnet: { label: 'Sonnet', modelID: 'claude-sonnet', contextWindow: 200000 } } } });
  store.cards.createCard = vi.fn(async (data) => makeCard(data.description ?? ''));
  store.cards.suggestTitle = vi.fn(async () => 'Suggested card');

  const onClose = vi.fn();
  render(
    <StoreProvider store={store}>
      <NewCardDetail column="backlog" initialProjectId={42} onCreated={vi.fn()} onClose={onClose} />
    </StoreProvider>,
  );

  return { store, onClose };
}

describe('NewCardDetail description draft persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  it('loads the unsaved description draft from local storage', () => {
    localStorage.setItem('orchestrel:new-card-draft-description', 'remember this card');

    renderNewCardDetail();

    expect(screen.getByPlaceholderText('Add a description...')).toHaveProperty('value', 'remember this card');
  });

  it('saves description edits to local storage and preserves them when closing', () => {
    const { onClose } = renderNewCardDetail();

    fireEvent.change(screen.getByPlaceholderText('Add a description...'), { target: { value: 'partial card notes' } });
    fireEvent.click(screen.getByRole('button', { name: '' }));

    expect(localStorage.getItem('orchestrel:new-card-draft-description')).toBe('partial card notes');
    expect(onClose).toHaveBeenCalled();
  });

  it('does not start title suggestion when clicking the close button', () => {
    const { store, onClose } = renderNewCardDetail();

    fireEvent.change(screen.getByPlaceholderText('Add a description...'), { target: { value: 'partial card notes' } });
    fireEvent.mouseDown(screen.getByRole('button', { name: '' }));
    fireEvent.click(screen.getByRole('button', { name: '' }));

    expect(store.cards.suggestTitle).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('clears the stored description only after a card is created successfully', async () => {
    const { store } = renderNewCardDetail();

    fireEvent.change(screen.getByPlaceholderText('Card title'), { target: { value: 'Saved card' } });
    fireEvent.change(screen.getByPlaceholderText('Add a description...'), { target: { value: 'completed description' } });
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(store.cards.createCard).toHaveBeenCalled());
    expect(store.cards.suggestTitle).not.toHaveBeenCalled();
    expect(localStorage.getItem('orchestrel:new-card-draft-description')).toBeNull();
  });

  it('hides archived projects from the new card project picker', async () => {
    const store = new RootStore();
    store.projects.hydrate([makeProject(42, 'Active Project'), makeProject(99, 'Archived Project', true)]);
    store.config.hydrate({ anthropic: { label: 'Anthropic', models: { sonnet: { label: 'Sonnet', modelID: 'claude-sonnet', contextWindow: 200000 } } } });

    render(
      <StoreProvider store={store}>
        <NewCardDetail column="backlog" onCreated={vi.fn()} onClose={vi.fn()} />
      </StoreProvider>,
    );

    const projectSelect = screen.getAllByRole('combobox')[1];
    projectSelect.focus();
    fireEvent.keyDown(projectSelect, { key: 'ArrowDown' });

    await waitFor(() => expect(projectSelect.getAttribute('aria-expanded')).toBe('true'));
    expect(screen.getByRole('option', { name: 'Active Project' })).not.toBeNull();
    expect(screen.queryByRole('option', { name: 'Archived Project' })).toBeNull();
  });
});
