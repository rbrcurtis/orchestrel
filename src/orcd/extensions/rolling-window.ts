import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import type { ExtensionAPI, ContextEvent, ContextEventResult } from '@oh-my-pi/pi-coding-agent';
import type { Message } from '@oh-my-pi/pi-ai';
import { ContextManager } from '../context/manager';
import { EVICTION_RATIO, MIN_TURNS_KEPT } from '../../shared/constants';

// Shared state for cache breakpoint coordination — will be moved to cache-breakpoints.ts in Task 6
let _stableBoundary = 0;
export function setStableBoundary(index: number): void { _stableBoundary = index; }
export function getStableBoundary(): number { return _stableBoundary; }

export interface RollingWindowOptions {
  messageBudgetTokens: number;
  evictionRatio?: number;
  minTurnsKept?: number;
  onEviction?: (evictedCount: number, remainingCount: number) => void;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

export function createRollingWindowExtension(opts: RollingWindowOptions): ExtensionFactory {
  return (api: ExtensionAPI): void => {
    const mgr = new ContextManager({
      messageBudgetTokens: opts.messageBudgetTokens,
      evictionRatio: opts.evictionRatio ?? EVICTION_RATIO,
      minTurnsKept: opts.minTurnsKept ?? MIN_TURNS_KEPT,
    });

    api.on('context', (event: ContextEvent): ContextEventResult => {
      const result = mgr.evict(event.messages as Message[]);

      if (result.evictedCount > 0) {
        opts.onEviction?.(result.evictedCount, result.messages.length);
      }

      setStableBoundary(result.stableBoundaryIndex);

      return { messages: result.messages as AgentMessage[] };
    });
  };
}
