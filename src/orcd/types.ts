export type SessionState = 'running' | 'completed' | 'errored' | 'stopped';

export interface SessionInfo {
  id: string;
  state: SessionState;
  cwd: string;
  model: string;
  provider: string;
}
