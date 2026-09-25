import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindOneBy = vi.fn();
const mockFindOne = vi.fn();
const mockIsActive = vi.fn();
const mockMessage = vi.fn();
const mockCreate = vi.fn();
const mockTrackSession = vi.fn();
const mockUpdateCard = vi.fn();
const mockDeleteCard = vi.fn();

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

// Hermetic resolver: the fallback test below must not depend on the machine's
// own config.yaml or on the gateway being up.
vi.mock('../../shared/config', () => ({
  loadConfig: () => ({
    sleepResolver: { provider: 'ray', model: 'gemma' },
    providers: {
      ray: { baseUrl: 'http://127.0.0.1:9', models: { gemma: { modelID: 'gemma', contextWindow: 32768 } } },
    },
  }),
}));

const mockClient = {
  isConnected: () => true,
  isActive: mockIsActive,
  message: mockMessage,
  create: mockCreate,
};

vi.mock('../init-state', () => ({
  getClientByNode: () => mockClient,
  getMessageBus: () => null,
  setMessageBus: () => {},
}));

vi.mock('./card', () => ({
  cardService: {
    updateCard: (...args: unknown[]) => mockUpdateCard(...args),
    deleteCard: (...args: unknown[]) => mockDeleteCard(...args),
  },
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
    mockDeleteCard.mockReset();
    mockUpdateCard.mockImplementation(async (id: number) => ({ id }));
  });

  it('sends the stripped prompt to the active session, then moves the card', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    mockFindOneBy.mockResolvedValue(activeCard());
    mockIsActive.mockReturnValue(true);

    await submitCardPrompt(42, 'great! /merge /qa /archive');

    expect(mockMessage).toHaveBeenCalledWith('sess-abc', 'great! /merge /qa', 'high');
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

  it('appends /ready moves after the last card in the ready column', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    mockFindOneBy.mockResolvedValue(activeCard());
    mockIsActive.mockReturnValue(true);
    mockFindOne.mockResolvedValue({ position: 7 });

    await submitCardPrompt(42, 'one more pass /ready');

    expect(mockFindOne).toHaveBeenCalledWith({ where: { column: 'ready' }, order: { position: 'DESC' } });
    expect(mockUpdateCard).toHaveBeenCalledWith(42, { column: 'ready', position: 8 });
  });

  it('deletes the card without prompting on a command-only /delete', async () => {
    const { submitCardPrompt } = await import('./card-execution');

    const result = await submitCardPrompt(42, '/delete');

    expect(result).toBeNull();
    expect(mockDeleteCard).toHaveBeenCalledWith(42);
    expect(mockMessage).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockFindOneBy).not.toHaveBeenCalled();
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it('discards surrounding text on /delete instead of prompting', async () => {
    const { submitCardPrompt } = await import('./card-execution');

    await submitCardPrompt(42, 'wait no /delete');

    expect(mockDeleteCard).toHaveBeenCalledWith(42);
    // No prompt: a session started right before deletion would be killed
    // instantly, and the text is gone with the card anyway.
    expect(mockMessage).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it('sends a normal prompt untouched and never moves the card', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    mockFindOneBy.mockResolvedValue(activeCard());
    mockIsActive.mockReturnValue(true);

    await submitCardPrompt(42, 'plain prompt with a path /tmp/x');

    expect(mockMessage).toHaveBeenCalledWith('sess-abc', 'plain prompt with a path /tmp/x', 'high');
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it('keeps the 422 rejection for empty messages without app commands', async () => {
    const { submitCardPrompt } = await import('./card-execution');

    await expect(submitCardPrompt(42, '   ')).rejects.toMatchObject({ code: 'invalid_prompt' });
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  // The wake prompt after "then" is stored on the card rather than sent, so the
  // split between time phrase and prompt has to hold at the command boundary.
  // An unreachable resolver is infrastructure, not a bad phrase: the command
  // must fall back to the pre-app-command path, where the stored /sleep prompt
  // reaches the session and its own model waits.
  it('passes the command through as a prompt when the resolver model is unreachable', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    const card = { ...activeCard(), column: 'ready' };
    mockFindOneBy.mockResolvedValue(card);
    mockIsActive.mockReturnValue(true);
    const fetchSpy = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:9')));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await submitCardPrompt(42, '/sleep middle of next month then check the deploy');
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchSpy).toHaveBeenCalled();
    // The message goes through as an ordinary prompt, command included, so orcd
    // can inject the stored /sleep prompt and the session does the wait itself.
    const [, text] = mockMessage.mock.calls[0] as [string, string];
    expect(text).toBe('/sleep middle of next month then check the deploy');
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it('keeps the error for a phrase that cannot be read', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    mockFindOneBy.mockResolvedValue(activeCard());
    const fetchSpy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'no idea, sorry' } }] }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await expect(submitCardPrompt(42, '/sleep middle of next month')).rejects.toMatchObject({
        code: 'sleep_unresolved',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stores the prompt given after "then" and parks the card', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    mockFindOneBy.mockResolvedValue(activeCard());

    await submitCardPrompt(42, '/sleep 2 hours then check the deploy');

    const [id, data] = mockUpdateCard.mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(42);
    expect(data.column).toBe('ready');
    expect(data.sleepPrompt).toBe('check the deploy');
    expect(data.sleepUntil as number).toBeGreaterThan(Date.now());
  });

  // A prompt is the user saying "run now", so it outranks a pending /sleep; and
  // a prompt that cannot start a session must not silently cancel the wake time
  // the user set. Both are single-field state transitions, cheap to pin here.
  it('clears a pending wake when a prompt pulls the card back to running', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    const card = { ...activeCard(), column: 'ready', sleepUntil: 1_790_298_759_931 };
    mockFindOneBy.mockResolvedValue(card);
    mockIsActive.mockReturnValue(true);

    await submitCardPrompt(42, 'go now please');

    expect(card.column).toBe('running');
    expect(card.sleepUntil).toBeNull();
    expect(card.save).toHaveBeenCalled();
  });

  it('restores the wake time when the prompt cannot start a session', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    const card = { ...activeCard(), sessionId: null, column: 'ready', sleepUntil: 1_790_298_759_931 };
    mockFindOneBy.mockResolvedValue(card);
    mockIsActive.mockReturnValue(false);
    mockCreate.mockRejectedValue(new Error('node down'));

    await expect(submitCardPrompt(42, 'go')).rejects.toThrow('node down');

    expect(card.column).toBe('ready');
    expect(card.sleepUntil).toBe(1_790_298_759_931);
  });

  it('broadcasts the submitted prompt to the card room so other viewers see it', async () => {
    const { submitCardPrompt } = await import('./card-execution');
    const { messageBus } = await import('../bus');
    mockFindOneBy.mockResolvedValue(activeCard());
    mockIsActive.mockReturnValue(true);

    const received: unknown[] = [];
    const handler = (p: unknown) => received.push(p);
    messageBus.subscribe('card:42:sdk', handler);
    try {
      await submitCardPrompt(42, 'great! /archive');
    } finally {
      messageBus.unsubscribe('card:42:sdk', handler);
    }

    // Stripped text only: the broadcast must match the sender's optimistic
    // echo exactly, or the sender dedupes against nothing and doubles up.
    expect(received).toEqual([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'great!' }] } },
    ]);
  });
});
