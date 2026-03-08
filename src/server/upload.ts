import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const MAX_FILES = 10;

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const safeId = (req.body?.sessionId || 'unsorted').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = join('/tmp/dispatcher-uploads', safeId);
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const id = randomUUID().slice(0, 8);
    cb(null, `${id}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
});

export const uploadRouter = Router();

uploadRouter.post('/api/upload', upload.array('files', MAX_FILES), (req, res) => {
  const files = req.files as Express.Multer.File[];
  if (!files?.length) {
    res.status(400).json({ error: 'No files uploaded' });
    return;
  }

  const refs = files.map((f) => ({
    id: f.filename.slice(0, 8),
    name: f.originalname,
    mimeType: f.mimetype,
    path: f.path,
    size: f.size,
  }));

  res.json({ files: refs });
});

uploadRouter.use('/api/upload', (err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File too large (25 MB max)' });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: 'Upload failed' });
});
