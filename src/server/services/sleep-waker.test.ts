import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFind = vi.fn();
const mockSubmit = vi.fn();
const mockPublish = vi.fn();

vi.mock('../models/Card', () => ({
  Card: { find: (...args: unknown[]) => mockFind(...args) },
}));

vi.mock('./card-execution', () => ({
  submitCardPrompt: (...args: unknown[]) => mockSubmit(...args),
}));

vi.mock('../bus', () => ({
  messageBus: {
    publish: (...args: unknown[]) => mockPublish(...args),
    subscribe: vi.fn(),
  },
}));

// The waker is the only thing that turns a stored wake time into work. Its two
// branches (send the stored prompt, or just start the card) and the failure
// branch decide what a parked card does when its time arrives.
function sleepingCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    column: 'ready',
    sleepUntil: 500,
    sleepPrompt: null,
    updatedAt: '',
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('wakeDueCards', () => {
  beforeEach(() => {
    mockFind.mockReset();
    mockSubmit.mockReset();
    mockPublish.mockReset();
  });

  it('sends the stored prompt when the wake time arrives', async () => {
    const card = sleepingCard({ sleepPrompt: 'check the deploy' });
    mockFind.mockResolvedValue([card]);
    const { wakeDueCards } = await import('./sleep');

    await wakeDueCards(1000);

    expect(mockSubmit).toHaveBeenCalledWith(7, 'check the deploy');
    // submitCardPrompt moves the card and starts the session itself.
    expect(card.column).toBe('ready');
    expect(card.sleepUntil).toBeNull();
    expect(card.sleepPrompt).toBeNull();
  });

  it('moves a card with no stored prompt straight to running', async () => {
    const card = sleepingCard();
    mockFind.mockResolvedValue([card]);
    const { wakeDueCards } = await import('./sleep');

    await wakeDueCards(1000);

    expect(card.column).toBe('running');
    expect(card.sleepUntil).toBeNull();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('reports a wake prompt that could not be sent instead of retrying it', async () => {
    const card = sleepingCard({ sleepPrompt: 'check the deploy' });
    mockFind.mockResolvedValue([card]);
    mockSubmit.mockRejectedValue(new Error('node offline'));
    const { wakeDueCards } = await import('./sleep');

    await expect(wakeDueCards(1000)).resolves.toBe(1);

    // Cleared before sending: a failing prompt must not fire on every tick.
    expect(card.sleepPrompt).toBeNull();
    expect(card.sleepUntil).toBeNull();
    expect(mockPublish).toHaveBeenCalledWith(
      'card:7:sdk',
      expect.objectContaining({ type: 'error', message: expect.stringContaining('node offline') }),
    );
  });
});
