import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export interface PromptChannel {
  push: (msg: SDKUserMessage) => void;
  close: () => void;
  iterator: AsyncIterableIterator<SDKUserMessage>;
}

export function createPromptChannel(): PromptChannel {
  let resolve: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  const pending: SDKUserMessage[] = [];
  let done = false;

  const push = (msg: SDKUserMessage) => {
    if (done) return;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: msg, done: false });
    } else {
      pending.push(msg);
    }
  };

  const close = () => {
    done = true;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: undefined as never, done: true });
    }
  };

  const iterator: AsyncIterableIterator<SDKUserMessage> = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (pending.length > 0) {
        return Promise.resolve({ value: pending.shift()!, done: false as const });
      }
      if (done) {
        return Promise.resolve({ value: undefined as never, done: true as const });
      }
      return new Promise((r) => { resolve = r; });
    },
    return() {
      close();
      return Promise.resolve({ value: undefined as never, done: true as const });
    },
    throw(err?: unknown) {
      close();
      return Promise.reject(err);
    },
  };

  return { push, close, iterator };
}

export function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}
