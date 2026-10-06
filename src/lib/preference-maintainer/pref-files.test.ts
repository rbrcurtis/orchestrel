import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { fileOps, prefFilePath } from './pref-files';

const EMAIL = 'wednesday@gmail.com';

describe('fileOps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pref-files-'));

  it('returns null for a user with no file and stores on first write', async () => {
    const ops = fileOps(EMAIL, dir);
    expect(await ops.read(EMAIL)).toBeNull();
    expect(await ops.search('anything')).toEqual([]);
    await ops.store({ title: `Preferences: ${EMAIL}`, text: 'lead with the answer (seen: 2026-10-06)' });
    const hit = await ops.read(EMAIL);
    expect(hit).toMatchObject({
      id: EMAIL,
      title: `Preferences: ${EMAIL}`,
      text: 'lead with the answer (seen: 2026-10-06)\n',
    });
    expect(readFileSync(prefFilePath(EMAIL, dir), 'utf8')).toContain('lead with the answer');
  });

  it('search finds only this user\'s canonical entry; foreign ids read as null', async () => {
    const ops = fileOps(EMAIL, dir);
    const hits = await ops.search('Preferences: wednesday@gmail.com');
    expect(hits.map((h) => h.title)).toEqual([`Preferences: ${EMAIL}`]);
    expect(await ops.read('someone-else@example.com')).toBeNull();
  });

  it('replaces the file on update and rejects a foreign id', async () => {
    const ops = fileOps(EMAIL, dir);
    await ops.update({ id: EMAIL, text: 'revised body' });
    expect(await ops.read(EMAIL)).toMatchObject({ text: 'revised body\n' });
    await expect(ops.update({ id: 'other@example.com', text: 'x' })).rejects.toThrow('unknown preference file id');
  });
});
