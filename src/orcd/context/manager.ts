import type { Message } from '@oh-my-pi/pi-ai';
import { estimateMessageTokens } from './token-estimator';

export interface ContextManagerConfig {
  messageBudgetTokens: number;
  evictionRatio: number;
  minTurnsKept: number;
}

export interface EvictionResult {
  messages: Message[];
  evictedCount: number;
  stableBoundaryIndex: number;
}

export interface Turn {
  messages: Message[];
  tokenEstimate: number;
}

export class ContextManager {
  private cfg: ContextManagerConfig;

  constructor(cfg: ContextManagerConfig) {
    this.cfg = cfg;
  }

  /**
   * Parse messages into turns. A turn starts with a `user` message and includes
   * all subsequent non-user messages until the next user message. If the array
   * begins with non-user messages they form their own initial turn.
   */
  parseTurns(messages: Message[]): Turn[] {
    if (messages.length === 0) return [];

    const turns: Turn[] = [];
    let current: Message[] = [];

    for (const msg of messages) {
      if (msg.role === 'user' && current.length > 0) {
        // Flush previous turn before starting a new one
        turns.push(buildTurn(current));
        current = [];
      }
      current.push(msg);
    }

    if (current.length > 0) {
      turns.push(buildTurn(current));
    }

    return turns;
  }

  /**
   * Evict oldest turns to bring token count within budget.
   * Respects minTurnsKept — never drops below that many turns.
   */
  evict(messages: Message[]): EvictionResult {
    if (messages.length === 0) {
      return { messages: [], evictedCount: 0, stableBoundaryIndex: 0 };
    }

    const turns = this.parseTurns(messages);
    const total = turns.reduce((sum, t) => sum + t.tokenEstimate, 0);
    const lastTurnSize = turns[turns.length - 1].messages.length;

    if (total <= this.cfg.messageBudgetTokens) {
      // Under budget — return all messages, stable boundary before last turn
      return {
        messages,
        evictedCount: 0,
        stableBoundaryIndex: messages.length - lastTurnSize,
      };
    }

    // Target: bring tokens down to budget * (1 - evictionRatio)
    const target = this.cfg.messageBudgetTokens * (1 - this.cfg.evictionRatio);

    // Evict oldest turns from the front, never dropping below minTurnsKept
    let evictedMsgs = 0;
    let kept = [...turns];
    let keptTokens = total;

    while (
      keptTokens > target &&
      kept.length > this.cfg.minTurnsKept
    ) {
      const oldest = kept[0];
      keptTokens -= oldest.tokenEstimate;
      evictedMsgs += oldest.messages.length;
      kept = kept.slice(1);
    }

    const keptMessages = kept.flatMap(t => t.messages);
    const newLastTurnSize = kept[kept.length - 1].messages.length;

    return {
      messages: keptMessages,
      evictedCount: evictedMsgs,
      stableBoundaryIndex: keptMessages.length - newLastTurnSize,
    };
  }
}

// ─── internal ─────────────────────────────────────────────────────────────────

function buildTurn(messages: Message[]): Turn {
  const tokenEstimate = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  return { messages, tokenEstimate };
}
