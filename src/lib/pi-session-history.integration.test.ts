import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { getPiSessionHistoryPage } from './pi-session-history';
import { TRANSCRIPT_PAGE_SIZE } from '../shared/transcript-history';

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
    expect(latest.records).toHaveLength(TRANSCRIPT_PAGE_SIZE);
    expect(new Set(latest.records.map((r) => r.id)).size).toBe(TRANSCRIPT_PAGE_SIZE);
    expect(latest.hasOlder).toBe(true);
    const older = await getPiSessionHistoryPage(id, dir, { before: latest.before!, revision: latest.revision });
    expect(older.records).toHaveLength(TRANSCRIPT_PAGE_SIZE);
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

// Card 989: an April card whose session file was cleaned up. The reader used to throw,
// the backend turned that into an error, and the client fell back to session:load on
// every reconnect — forever, for a transcript that no longer exists.
it('answers an empty page when the session file is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'history-gone-'));
  try {
    const page = await getPiSessionHistoryPage('00000000-0000-4000-8000-000000000000', dir, {});
    expect(page.records).toEqual([]);
    expect(page.hasOlder).toBe(false);
    expect(page.hasNewer).toBe(false);
    expect(page.reset).toBe(false);
    expect(page.sessionId).toBe('00000000-0000-4000-8000-000000000000');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
