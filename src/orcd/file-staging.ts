import { basename, dirname, join, resolve, sep } from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import type { FileRef } from '../shared/ws-protocol';
import type { FileStageAction } from '../shared/orcd-protocol';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
export const FILE_STAGING_ROOT = '/tmp/orchestrel-attachments';

export function createFileStager(root = FILE_STAGING_ROOT) {
  const base = resolve(root);
  mkdirSync(base, { recursive: true });

  function inside(path: string): string {
    const full = resolve(path);
    if (!full.startsWith(`${base}${sep}`)) throw new Error('Staged path is outside staging root');
    return full;
  }

  return {
    stage(input: Pick<FileStageAction, 'cardId' | 'file'>): FileRef {
      if (!Number.isSafeInteger(input.cardId) || input.cardId <= 0) throw new Error('Invalid card ID');
      if (!SAFE_ID.test(input.file.id)) throw new Error('Invalid attachment ID');
      const bytes = Buffer.from(input.file.base64, 'base64');
      if (bytes.length !== input.file.size) throw new Error('Attachment size mismatch');
      if (bytes.length > MAX_BYTES) throw new Error('Attachment exceeds the 25 MB limit');
      const name = basename(input.file.name).replace(/[^A-Za-z0-9._ -]/g, '_') || 'attachment';
      const path = inside(join(base, String(input.cardId), `${input.file.id}-${name}`));
      mkdirSync(dirname(path), { recursive: true });

      if (!existsSync(path) || !readFileSync(path).equals(bytes)) {
        const temp = `${path}.tmp`;
        writeFileSync(temp, bytes);
        renameSync(temp, path);
      }

      return { id: input.file.id, name, mimeType: input.file.mimeType, size: bytes.length, path };
    },

    prune(now = Date.now()): void {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = inside(join(base, entry.name));
        if (now - statSync(dir).mtimeMs > MAX_AGE_MS) rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export const fileStager = createFileStager();
