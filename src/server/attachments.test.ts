import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAttachmentStore } from './attachments';

const roots: string[] = [];

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrel-attachments-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('attachment store', () => {
  it('stores sanitized files and reads only paths inside its root', () => {
    const store = createAttachmentStore(root());
    const ref = store.write('draft-1', '../../invoice.pdf', 'application/pdf', Buffer.from('pdf'));

    expect(ref.name).toBe('invoice.pdf');
    expect(store.read(ref).toString()).toBe('pdf');
    expect(() => store.read({ ...ref, path: '/etc/passwd' })).toThrow('outside attachment root');
  });

  it('rejects invalid draft ids', () => {
    const store = createAttachmentStore(root());

    expect(() => store.write('../escape', 'x.txt', 'text/plain', Buffer.from('x'))).toThrow('Invalid draft ID');
  });

  it('deletes files through validated references', () => {
    const store = createAttachmentStore(root());
    const ref = store.write('draft-1', 'x.txt', 'text/plain', Buffer.from('x'));

    store.delete([ref]);

    expect(() => readFileSync(ref.path)).toThrow();
  });

  it('prunes draft directories older than seven days', () => {
    const dir = root();
    const store = createAttachmentStore(dir);
    const old = store.write('old', 'old.txt', 'text/plain', Buffer.from('old'));
    const fresh = store.write('fresh', 'fresh.txt', 'text/plain', Buffer.from('fresh'));
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, 'old'), oldTime, oldTime);
    writeFileSync(fresh.path, 'fresh');

    store.prune();

    expect(() => readFileSync(old.path)).toThrow();
    expect(readFileSync(fresh.path, 'utf8')).toBe('fresh');
  });
});
