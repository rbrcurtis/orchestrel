import type { ExtensionAPI, BeforeProviderRequestEvent } from '@oh-my-pi/pi-coding-agent';
import type { ExtensionFactory } from './rolling-window';
import { getStableBoundary } from './rolling-window';

export interface BreakpointOptions {
  stableBoundaryIndex: number;
}

type CacheControl = { type: string };
type ContentBlock = { type: string; text?: string; cache_control?: CacheControl };
type Message = { role: string; content: string | ContentBlock[] };
type AnthropicPayload = { system: ContentBlock[]; messages: Message[] };

const EPHEMERAL: CacheControl = { type: 'ephemeral' };

function isAnthropicPayload(payload: unknown): payload is AnthropicPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return Array.isArray(p['system']) && Array.isArray(p['messages']);
}

function addBreakpointToLastBlock(blocks: ContentBlock[]): boolean {
  if (blocks.length === 0) return false;
  const last = blocks[blocks.length - 1];
  last.cache_control = EPHEMERAL;
  return true;
}

/**
 * Injects up to 3 cache_control breakpoints into an Anthropic API payload:
 * 1. Last block in system array
 * 2. Last content block of messages[stableBoundaryIndex - 1] (if > 0)
 * 3. Last content block of the last user message
 */
export function injectBreakpoints(payload: unknown, opts: BreakpointOptions): unknown {
  if (!isAnthropicPayload(payload)) return payload;

  let breakpoints = 0;
  const MAX_BREAKPOINTS = 4;

  // Breakpoint 1: last system block
  if (payload.system.length > 0 && breakpoints < MAX_BREAKPOINTS) {
    addBreakpointToLastBlock(payload.system);
    breakpoints++;
  }

  // Breakpoint 2: stable boundary — last content block of messages[stableBoundaryIndex - 1]
  if (opts.stableBoundaryIndex > 0 && breakpoints < MAX_BREAKPOINTS) {
    const boundaryMsg = payload.messages[opts.stableBoundaryIndex - 1];
    if (boundaryMsg && Array.isArray(boundaryMsg.content) && boundaryMsg.content.length > 0) {
      addBreakpointToLastBlock(boundaryMsg.content);
      breakpoints++;
    }
  }

  // Breakpoint 3: last user message
  if (breakpoints < MAX_BREAKPOINTS) {
    // Find the last user message
    for (let i = payload.messages.length - 1; i >= 0; i--) {
      const msg = payload.messages[i];
      if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.length > 0) {
        // Only add if this isn't already the boundary message we just marked
        addBreakpointToLastBlock(msg.content);
        breakpoints++;
        break;
      }
    }
  }

  return payload;
}

/**
 * Pi extension factory that injects cache breakpoints before each provider request.
 */
export function createCacheBreakpointExtension(): ExtensionFactory {
  return (api: ExtensionAPI): void => {
    api.on('before_provider_request', (event: BeforeProviderRequestEvent) => {
      return injectBreakpoints(event.payload, { stableBoundaryIndex: getStableBoundary() });
    });
  };
}
