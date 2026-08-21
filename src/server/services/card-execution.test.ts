import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindOneBy = vi.fn();
const mockFindOne = vi.fn();
const mockIsActive = vi.fn();
const mockMessage = vi.fn();
const mockCreate = vi.fn();
const mockTrackSession = vi.fn();
const mockUpdateCard = vi.fn();

vi.mock('../models/Card', () => ({
  Card: {
    findOneBy: (...args: unknown[]) => mockFindOneBy(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
}));

vi.mock('../sessions/worktree', () => ({
  ensureWorktree: vi.fn().mockResolvedValue('/tmp/wt'),
}));

vi.mock('../sessions/manager', () => ({
  buildPromptWithFiles: (msg: string, files?: unknown[]) => (files?.length ? `[files]\n${msg}` : msg),
}));

vi.mock('../controllers/card-sessions', () => ({
  clearCreatePending: vi.fn(),
  markCreatePending: vi.fn(),
  trackSession: (...args: unknown[]) => mockTrackSession(...args),
}));

vi.mock('../config/capabilities', () => ({
  windowForCard: () => 200_000,
}));

const mockClient = {
  isConnected: () => true,
  isActive: mockIsActive,
  message: mockMessage,
  create: mockCreate,
};

vi.mock('../init-state', () => ({
  getClientByNode: () => mockClient,
}));

vi.mock('./card', () => ({
  cardService: { updateCard: (...args: unknown[]) => mockUpdateCard(...args) },
}));

function activeCard() {
  return {
    id: 42,
    sessionId: 'sess-abc',
    column: 'running',
    promptsSent: 1,
    provider: 'anthropic',
    model: 'sonnet',
    thinkingLevel: 'high',
    summarizeThreshold: 0,
    contextWindow: 200_000,
    updatedAt: '',
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe('submitCardPrompt app slash commands', () => {
  beforeEach(() => {
    mockFindOneBy.mockReset();
    mockFindOne.mockReset();
    mockIsActive.mockReset();
    mockMessage.mockReset();
    mockCreate.mockReset();
    mockTrackSession.mockReset();
    mockUpdateCard.mockReset();
    mockUpdateCard.mockImplementation(async (id: number) => ({ id }));
  });

  it('sends the stripped prompt to the active session, then moves the card', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    mockFindOneBy.mockResolvedValue(activeCard());
    mockIsActive.mockReturnValue(true);

    await submitCardPrompt(42, 'great! /merge /qa /archive');

    expect(mockMessage).toHaveBeenCalledWith('sess-abc', 'great! /merge /qa');
    expect(mockUpdateCard).toHaveBeenCalledWith(42, { column: 'archive' });
    // The move must land AFTER the prompt is accepted — reversed, the card
    // would be parked before the model ever sees the message.
    expect(mockMessage.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateCard.mock.invocationCallOrder[0]);
  });

  it('moves the card without prompting when the message is only an app command', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    mockFindOne.mockResolvedValue(null);

    await submitCardPrompt(42, '/archive');

    expect(mockMessage).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockFindOneBy).not.toHaveBeenCalled();
    expect(mockUpdateCard).toHaveBeenCalledWith(42, { column: 'archive' });
  });

  it('appends /done moves after the last card in the done column', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    mockFindOne.mockResolvedValue({ position: 3 });

    await submitCardPrompt(42, '/done');

    expect(mockFindOne).toHaveBeenCalledWith({ where: { column: 'done' }, order: { position: 'DESC' } });
    expect(mockUpdateCard).toHaveBeenCalledWith(42, { column: 'done', position: 4 });
  });

  it('starts /done positions at 0 for an empty done column', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    mockFindOneBy.mockResolvedValue(activeCard());
    mockIsActive.mockReturnValue(true);
    mockFindOne.mockResolvedValue(null);

    await submitCardPrompt(42, 'ship it /done');

    expect(mockUpdateCard).toHaveBeenCalledWith(42, { column: 'done', position: 0 });
  });

  it('sends a normal prompt untouched and never moves the card', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    mockFindOneBy.mockResolvedValue(activeCard());
    mockIsActive.mockReturnValue(true);

    await submitCardPrompt(42, 'plain prompt with a path /tmp/x');

    expect(mockMessage).toHaveBeenCalledWith('sess-abc', 'plain prompt with a path /tmp/x');
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it('keeps the 422 rejection for empty messages without app commands', async () => {
    const { submitCardPrompt } = await import('./card-execution');

    await expect(submitCardPrompt(42, '   ')).rejects.toMatchObject({ code: 'invalid_prompt' });
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });
});
