import type { Socket } from 'net';
import type { OrcdMessage } from '../shared/orcd-protocol';

/**
 * Wake timing for parked cards.
 *
 * This lives in the daemon because a wake is session lifecycle work, and because more than
 * one backend can serve the same board. A timer in the backend meant the same wake fired
 * once per running backend. The backend that receives `sleep_due` still decides whether to
 * act: it claims the wake against the database first, so exactly one wakes the card.
 *
 * Schedules are not persisted. `cards.sleep_until` stays the durable record, and a backend
 * re-registers what it finds there when it connects.
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

interface Scheduled {
  timer: NodeJS.Timeout;
  wakeAt: number;
}

export class SleepScheduler {
  /** Keyed by connection, then card: each backend owns its own timer for the same card. */
  private bySocket = new Map<Socket, Map<number, Scheduled>>();

  schedule(socket: Socket, cardId: number, wakeAt: number, send: (msg: OrcdMessage) => void): void {
    this.cancel(socket, cardId);
    let cards = this.bySocket.get(socket);
    if (!cards) this.bySocket.set(socket, (cards = new Map()));

    const arm = (target: number) => {
      const delay = Math.min(Math.max(target - Date.now(), 0), MAX_TIMEOUT_MS);
      const timer = setTimeout(() => {
        if (target > Date.now()) {
          // A wait can outlast the largest timeout, so a long one re-arms until it is due.
          arm(target);
        } else {
          cards.delete(cardId);
          console.log(`[sleep] card ${cardId} is due; telling the backend`);
          send({ type: 'sleep_due', cardId });
        }
      }, delay);
      timer.unref();
      cards.set(cardId, { timer, wakeAt: target });
    };

    arm(wakeAt);
    console.log(
      `[sleep] card ${cardId} wake scheduled for ${new Date(wakeAt).toISOString()} (in ${Math.max(0, Math.round((wakeAt - Date.now()) / 1000))}s)`,
    );
  }

  cancel(socket: Socket, cardId: number): boolean {
    const cards = this.bySocket.get(socket);
    const entry = cards?.get(cardId);
    let cancelled = false;
    if (cards && entry) {
      clearTimeout(entry.timer);
      cards.delete(cardId);
      if (cards.size === 0) this.bySocket.delete(socket);
      cancelled = true;
    }
    console.log(`[sleep] cancel wake for card ${cardId}: ${cancelled ? 'dropped' : 'nothing scheduled'}`);
    return cancelled;
  }

  /** Drop every timer a connection registered, so a backend that goes away leaves nothing behind. */
  forget(socket: Socket): number {
    const cards = this.bySocket.get(socket);
    const dropped = cards?.size ?? 0;
    if (cards) {
      for (const entry of cards.values()) clearTimeout(entry.timer);
      this.bySocket.delete(socket);
    }
    return dropped;
  }

  get size(): number {
    let total = 0;
    for (const cards of this.bySocket.values()) total += cards.size;
    return total;
  }
}
