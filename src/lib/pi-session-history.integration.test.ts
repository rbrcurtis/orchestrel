import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { getPiSessionHistoryPage } from './pi-session-history';

it('pages stable entry identities and rejects a changed prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'history-page-'));
  try {
    const manager = SessionManager.create(dir);
    for (let i = 0; i < 135; i++) {
      manager.appendMessage({ role: 'user', content: 'identical prompt', timestamp: 1 });
      manager.appendMessage(fauxAssistantMessage(`answer-${i}`));
    }
    const id = manager.getSessionId();
    const latest = await getPiSessionHistoryPage(id, dir, {});
    expect(latest.records).toHaveLength(120);
    expect(new Set(latest.records.map((r) => r.id)).size).toBe(120);
    expect(latest.hasOlder).toBe(true);
    const older = await getPiSessionHistoryPage(id, dir, { before: latest.before!, revision: latest.revision });
    expect(older.records).toHaveLength(120);
    expect(older.hasNewer).toBe(true);
    expect(latest.records.some((r) => older.records.some((o) => o.id === r.id))).toBe(false);
    const unchanged = await getPiSessionHistoryPage(id, dir, { after: latest.after!, prefix: latest.prefix });
    expect(unchanged.records).toEqual([]);
    expect(unchanged.reset).toBe(false);
    manager.appendMessage({ role: 'user', content: 'new', timestamp: 1 });
    const delta = await getPiSessionHistoryPage(id, dir, { after: latest.after!, prefix: latest.prefix });
    expect(delta.records).toHaveLength(1);
    expect(delta.reset).toBe(false);
    const stale = await getPiSessionHistoryPage(id, dir, { after: latest.after!, prefix: 'bad' });
    expect(stale.reset).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
