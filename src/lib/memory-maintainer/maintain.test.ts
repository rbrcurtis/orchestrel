import { describe, expect, it } from 'vitest';
import type { OrchestrelConfig } from '../../shared/config';
import { buildAlertText, runMaintain } from './maintain';

const BASE: OrchestrelConfig = {
  listen: { host: '127.0.0.1', port: 1 },
  authToken: 't',
  name: 'test',
  defaultProvider: 'max',
  defaultModel: 'assistant',
  ringBufferSize: 100,
  providers: { max: { baseUrl: 'http://max.local:11434', apiKey: 'x', models: { assistant: { label: 'a', modelID: 'm', contextWindow: 1000 } } } },
};

describe('runMaintain', () => {
  it('returns null when memory config is absent', async () => {
    expect(await runMaintain(BASE)).toBeNull();
  });
});

describe('buildAlertText', () => {
  it('summarizes per-project counts', () => {
    const text = buildAlertText(
      {
        runId: 7,
        durationMs: 1234,
        stagingFiles: ['data/memory-staging/2026-08-31.json'],
        projects: [
          { project: 'trackable', sessions: 2, ops: 5, stores: 3, updates: 1, deletes: 0, skips: 1, errors: [] },
        ],
      },
      'data/memory-staging',
    );
    expect(text).toContain('trackable');
    expect(text).toContain('2 sessions');
    expect(text).toContain('3 stores');
    expect(text).toContain('2026-08-31.json');
  });
});
