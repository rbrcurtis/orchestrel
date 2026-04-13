export type SessionState = 'running' | 'completed' | 'errored' | 'stopped';

export interface SessionInfo {
  id: string;
  state: SessionState;
  cwd: string;
  model: string;
  provider: string;
}

export interface PiSessionOptions {
  cwd: string;
  model: string;
  provider: string;
  providerConfig: import('./config').ProviderConfig;
  openrouterConfig?: import('./config').ProviderConfig;
  bufferSize?: number;
  sessionId?: string;
  contextWindow?: number;
  effort?: string;
  project?: string;
}
