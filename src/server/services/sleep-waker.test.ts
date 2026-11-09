import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindOneBy = vi.fn();
const mockFind = vi.fn();
const mockExecute = vi.fn();
const mockSubmit = vi.fn();
const mockPublish = vi.fn();

vi.mock('../models/Card', () => ({
  Card: {
    findOneBy: (...args: unknown[]) => mockFindOneBy(...args),
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

// The claim is a conditional UPDATE whose row count decides whether this backend acts.
// Its WHERE clause is TypeORM's business; what matters here is that a claim of zero rows
// ends the wake without prompting anything.
vi.mock('../models/index', () => ({
  AppDataSource: {
    getRepository: () => ({
      createQueryBuilder: () => ({
        update() {
          return this;
        },
        set() {
          return this;
        },
        where() {
          return this;
        },
        execute: (...args: unknown[]) => mockExecute(...args),
      }),
    }),
  },
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

// The poll re-reads the rows every tick, and the claim is what stops a second backend
// doing the same wake. A parked card's two branches — send the stored prompt, or just
// start the card — decide what happens when its time arrives.
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

async function wake(cardId = 7, now = 1000) {
  const { wakeDueCard } = await import('./sleep');
  return wakeDueCard(cardId, now);
}

describe('wakeDueCards', () => {
  beforeEach(() => {
    mockFind.mockReset();
    mockFindOneBy.mockReset();
    mockExecute.mockReset().mockResolvedValue({ affected: 1 });
    mockSubmit.mockReset();
  });

  // The whole point of the poll: a wake that came due while the machine was off is still
  // in the rows, so the next tick finds it instead of relying on a remembered schedule.
  it('wakes every due card it finds in the rows', async () => {
    mockFind.mockResolvedValue([{ id: 7 }, { id: 8 }]);
    mockFindOneBy.mockImplementation(async ({ id }: { id: number }) =>
      sleepingCard({ id, sleepPrompt: `prompt ${id}` }),
    );

    const { wakeDueCards } = await import('./sleep');
    expect(await wakeDueCards(1000)).toBe(2);
    expect(mockSubmit).toHaveBeenCalledWith(7, 'prompt 7');
    expect(mockSubmit).toHaveBeenCalledWith(8, 'prompt 8');
  });
});

describe('wakeDueCard', () => {
  beforeEach(() => {
    mockFindOneBy.mockReset();
    mockExecute.mockReset().mockResolvedValue({ affected: 1 });
    mockSubmit.mockReset();
    mockPublish.mockReset();
  });

  it('sends the stored prompt when the wake time arrives', async () => {
    mockFindOneBy.mockResolvedValue(sleepingCard({ sleepPrompt: 'check the deploy' }));

    expect(await wake()).toBe(true);
    expect(mockExecute).toHaveBeenCalled();
    expect(mockSubmit).toHaveBeenCalledWith(7, 'check the deploy');
  });

  it('moves a card with no stored prompt to running instead', async () => {
    const card = sleepingCard();
    mockFindOneBy.mockResolvedValue(card);

    expect(await wake()).toBe(true);
    expect(card.column).toBe('running');
    expect(card.save).toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  // Two backends can both be told a card is due. Only the one whose claim changes a row
  // may act, or the card would be woken twice.
  it('does nothing when another backend already claimed the wake', async () => {
    mockFindOneBy.mockResolvedValue(sleepingCard({ sleepPrompt: 'check the deploy' }));
    mockExecute.mockResolvedValue({ affected: 0 });

    expect(await wake()).toBe(false);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('ignores a card that is gone, not in ready, not asleep, or not due yet', async () => {
    mockFindOneBy.mockResolvedValue(undefined);
    expect(await wake()).toBe(false);

    mockFindOneBy.mockResolvedValue(sleepingCard({ column: 'running' }));
    expect(await wake()).toBe(false);

    mockFindOneBy.mockResolvedValue(sleepingCard({ sleepUntil: null }));
    expect(await wake()).toBe(false);

    mockFindOneBy.mockResolvedValue(sleepingCard({ sleepUntil: 5000 }));
    expect(await wake()).toBe(false);

    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('reports a wake prompt that failed instead of retrying it', async () => {
    mockFindOneBy.mockResolvedValue(sleepingCard({ sleepPrompt: 'check the deploy' }));
    mockSubmit.mockRejectedValue(new Error('node down'));

    expect(await wake()).toBe(true);
    expect(mockPublish).toHaveBeenCalledWith(
      'card:7:sdk',
      expect.objectContaining({ type: 'error', message: expect.stringContaining('node down') }),
    );
  });
});
