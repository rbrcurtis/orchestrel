import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileStager } from '../file-staging';

const roots: string[] = [];
function root() {
  const dir = mkdtempSync(join(tmpdir(), 'orcd-stage-'));
  roots.push(dir);
  return dir;
}
afterEach(() => roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const input = {
  cardId: 42,
  file: {
    id: 'abc',
    name: '../photo.png',
    mimeType: 'image/png',
    size: 3,
    base64: Buffer.from('img').toString('base64'),
  },
};

describe('orcd file staging', () => {
  it('writes decoded bytes under the card root and sanitizes names', () => {
    const staged = createFileStager(root()).stage(input);

    expect(staged.name).toBe('photo.png');
    expect(readFileSync(staged.path, 'utf8')).toBe('img');
  });

  it('is idempotent for the same card and attachment id', () => {
    const stager = createFileStager(root());
    const first = stager.stage(input);
    const second = stager.stage(input);

    expect(second.path).toBe(first.path);
    expect(readFileSync(second.path, 'utf8')).toBe('img');
  });

  it('rejects invalid ids and decoded size mismatches', () => {
    const stager = createFileStager(root());
    expect(() => stager.stage({ ...input, file: { ...input.file, id: '../bad' } })).toThrow('Invalid attachment ID');
    expect(() => stager.stage({ ...input, file: { ...input.file, size: 4 } })).toThrow('size mismatch');
  });

  it('prunes staging directories older than seven days', () => {
    const dir = root();
    const stager = createFileStager(dir);
    const staged = stager.stage(input);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, '42'), old, old);

    stager.prune();

    expect(() => readFileSync(staged.path)).toThrow();
  });
});
