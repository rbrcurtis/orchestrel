import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { buildExcerpt } from './excerpt';

const LINES = [
  { type: 'session', id: 's1', timestamp: '2026-08-31T00:00:00Z', cwd: '/home/ryan/Code/trackable' },
  { type: 'model_change', id: 'mc', timestamp: '2026-08-31T00:00:01Z', provider: 'qwen', modelId: 'qwen3.8-max' },
  {
    type: 'message', id: 'u1', timestamp: '2026-08-31T00:00:02Z',
    message: { role: 'user', content: [{ type: 'text', text: 'fix the pipeline retry bug' }] },
  },
  {
    type: 'message', id: 'a1', timestamp: '2026-08-31T00:00:03Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'long reasoning we do not want' },
        { type: 'text', text: 'I will add a retry with backoff.' },
        { type: 'toolCall', id: 't1', name: 'edit', arguments: { filePath: 'src/x.ts' } },
      ],
    },
  },
  {
    type: 'message', id: 'r1', timestamp: '2026-08-31T00:00:04Z',
    message: { role: 'toolResult', toolCallId: 't1', toolName: 'edit', content: [{ type: 'text', text: 'ok' }] },
  },
];

function writeFixture(name: string, lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mm-ex-'));
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
  return p;
}

describe('buildExcerpt', () => {
  it('extracts user/assistant/tool content and skips thinking', () => {
    const ex = buildExcerpt(writeFixture('s.jsonl', LINES), 1000);
    expect(ex.sessionId).toBe('s1');
    expect(ex.cwd).toBe('/home/ryan/Code/trackable');
    expect(ex.text).toContain('fix the pipeline retry bug');
    expect(ex.text).toContain('I will add a retry with backoff.');
    expect(ex.text).toContain('edit');
    expect(ex.text).toContain('ok');
    expect(ex.text).not.toContain('long reasoning');
    expect(ex.tokenEstimate).toBeGreaterThan(0);
  });

  it('trims oldest content when over budget', () => {
    const long = [
      ...LINES,
      {
        type: 'message', id: 'u2', timestamp: '2026-08-31T00:00:05Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Z'.repeat(5000) }] },
      },
    ];
    const ex = buildExcerpt(writeFixture('big.jsonl', long), 1280);
    expect(ex.tokenEstimate).toBeLessThanOrEqual(1280);
    expect(ex.text).not.toContain('fix the pipeline retry bug');
    expect(ex.text).toContain('Z'.repeat(4990));
  });

  it('redacts secret-like strings from every emitted part', () => {
    const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const lines = [
      ...LINES,
      {
        type: 'message', id: 'u3', timestamp: '2026-08-31T00:00:06Z',
        message: { role: 'user', content: [{ type: 'text', text: `use ${SECRET} as the key` }] },
      },
    ];
    const ex = buildExcerpt(writeFixture('secret.jsonl', lines), 1000);
    expect(ex.text).not.toContain(SECRET);
    expect(ex.text).toContain('[redacted]');
  });
});
