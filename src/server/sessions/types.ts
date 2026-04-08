import type { Query } from '@anthropic-ai/claude-agent-sdk';

export type SessionStatus = 'starting' | 'running' | 'completed' | 'errored' | 'stopped' | 'retry';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ActiveSession {
  cardId: number;
  query: Query;
  sessionId: string | null;
  provider: string;
  model: string;
  status: SessionStatus;
  promptsSent: number;
  turnsCompleted: number;
  turnCost: number;
  turnUsage: Usage | null;
  cwd: string;
}

export interface SessionStartOpts {
  provider: string;
  model: string;
  cwd: string;
  resume?: string;
}
