import express, { type Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { basename, dirname, join, resolve, sep } from 'path';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import type { FileRef } from '../shared/ws-protocol';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_ROOT = join(process.cwd(), 'data', 'attachments');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function safeName(name: string): string {
  return basename(name).replace(/[^A-Za-z0-9._ -]/g, '_') || 'attachment';
}

export function createAttachmentStore(root = ATTACHMENT_ROOT) {
  const base = resolve(root);
  mkdirSync(base, { recursive: true });

  function inside(path: string): string {
    const full = resolve(path);
    if (!full.startsWith(`${base}${sep}`)) throw new Error('Attachment path is outside attachment root');
    return full;
  }

  return {
    write(draftId: string, name: string, mimeType: string, bytes: Buffer): FileRef {
      if (!SAFE_ID.test(draftId)) throw new Error('Invalid draft ID');
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`${name} exceeds the 25 MB limit`);
      const id = randomUUID().slice(0, 8);
      const clean = safeName(name);
      const path = inside(join(base, draftId, `${id}-${clean}`));
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      writeFileSync(temp, bytes);
      renameSync(temp, path);
      return { id, name: clean, mimeType: mimeType || 'application/octet-stream', path, size: bytes.length };
    },

    read(ref: FileRef): Buffer {
      return readFileSync(inside(ref.path));
    },

    delete(refs: FileRef[]): void {
      for (const ref of refs) rmSync(inside(ref.path), { force: true });
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

const store = createAttachmentStore();

export function readAttachment(ref: FileRef): Buffer {
  return store.read(ref);
}

export function deleteAttachments(refs: FileRef[]): void {
  store.delete(refs);
}

export function pruneAttachments(now?: number): void {
  store.prune(now);
}

export function createAttachmentRouter(): Router {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES } });

  router.post('/api/upload', upload.array('files'), (req, res) => {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files?.length) {
      console.warn('[rest:upload] no files in request');
      res.status(400).json({ error: 'No files uploaded' });
      return;
    }

    try {
      const draftId = typeof req.body?.draftId === 'string' ? req.body.draftId : undefined;
      if (draftId) {
        const refs = files.map((file) => store.write(draftId, file.originalname, file.mimetype, file.buffer));
        console.log(`[rest:upload] stored ${refs.length} durable files for draft ${draftId}`);
        res.json({ files: refs });
        return;
      }

      const raw = typeof req.body?.sessionId === 'string' ? req.body.sessionId : 'unsorted';
      const sessionId = raw.replace(/[^A-Za-z0-9_-]/g, '_');
      const dir = join('/tmp/orchestrel-uploads', sessionId);
      mkdirSync(dir, { recursive: true });
      const refs = files.map((file): FileRef => {
        const id = randomUUID().slice(0, 8);
        const name = safeName(file.originalname);
        const path = join(dir, `${id}-${name}`);
        writeFileSync(path, file.buffer);
        return { id, name, mimeType: file.mimetype, path, size: file.size };
      });
      res.json({ files: refs });
    } catch (err) {
      console.error('[rest:upload] failed:', err instanceof Error ? err.message : String(err));
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
