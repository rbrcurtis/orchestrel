import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'net';
import type { OrcdMessage } from '../shared/orcd-protocol';
import { SleepScheduler } from './sleep-scheduler';

// Each connection owns its own timers for a card, and the backend claims the wake in the
// database when one fires. That is what makes a single wake per card possible while more
// than one backend serves the same board.
describe('SleepScheduler', () => {
  let scheduler: SleepScheduler;
  let send: (msg: OrcdMessage) => void;
  const socket = { id: 'sock-1' } as unknown as Socket;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new SleepScheduler();
    send = vi.fn<(msg: OrcdMessage) => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells the backend when the wake time arrives', () => {
    scheduler.schedule(socket, 7, Date.now() + 60_000, send);

    vi.advanceTimersByTime(59_000);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(send).toHaveBeenCalledWith({ type: 'sleep_due', cardId: 7 });
  });

  it('fires a wake whose time already passed', () => {
    scheduler.schedule(socket, 7, Date.now() - 5_000, send);

    vi.advanceTimersByTime(0);
    expect(send).toHaveBeenCalledWith({ type: 'sleep_due', cardId: 7 });
  });

  it('keeps one timer per card: a later schedule replaces the earlier one', () => {
    scheduler.schedule(socket, 7, Date.now() + 30_000, send);
    scheduler.schedule(socket, 7, Date.now() + 120_000, send);
    expect(scheduler.size).toBe(1);

    vi.advanceTimersByTime(60_000);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('drops a cancelled wake', () => {
    scheduler.schedule(socket, 7, Date.now() + 60_000, send);
    expect(scheduler.cancel(socket, 7)).toBe(true);
    expect(scheduler.cancel(socket, 7)).toBe(false);

    vi.advanceTimersByTime(120_000);
    expect(send).not.toHaveBeenCalled();
  });

  // A backend that goes away must leave nothing behind.
  it('forgets every wake a disconnected connection registered', () => {
    const other = { id: 'sock-2' } as unknown as Socket;
    scheduler.schedule(socket, 7, Date.now() + 60_000, send);
    scheduler.schedule(socket, 8, Date.now() + 60_000, send);
    scheduler.schedule(other, 9, Date.now() + 60_000, send);

    expect(scheduler.forget(socket)).toBe(2);
    expect(scheduler.size).toBe(1);

    vi.advanceTimersByTime(120_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'sleep_due', cardId: 9 });
  });
});
