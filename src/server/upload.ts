import { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const MAX_FILES = 10;

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const sessionId = req.body?.sessionId || 'unsorted';
    const dir = join('/tmp/dispatcher-uploads', sessionId);
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
