import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { deleteTranscriptCache, readTranscriptPage, writeTranscriptPage } from './transcript-cache';

it('isolates accounts and rejects stale page writes without clearing newer records', async () => {
  const scope = { userId: 1, nodeName: 'local', sessionId: 'cache-test' };
  await deleteTranscriptCache(scope);
  const first = { anchor: 'latest', revision: 'r1', records: [{ id: 'one', text: 'hello' }] };
  expect(await writeTranscriptPage(scope, first, null)).toBe(true);
  expect(await readTranscriptPage(scope, 'latest')).toEqual(first);
  expect(await readTranscriptPage({ ...scope, userId: 2 }, 'latest')).toBeUndefined();
  const next = { ...first, revision: 'r2', records: [...first.records, { id: 'two', text: 'hello' }] };
  expect(await writeTranscriptPage(scope, next, 'r1')).toBe(true);
  expect(await writeTranscriptPage(scope, first, 'r1')).toBe(false);
  expect(await readTranscriptPage(scope, 'latest')).toEqual(next);
  await deleteTranscriptCache(scope);
  expect(await readTranscriptPage(scope, 'latest')).toBeUndefined();
});
