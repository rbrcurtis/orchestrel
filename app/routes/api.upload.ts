import type { ActionFunctionArgs } from 'react-router';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const rawSessionId = (formData.get('sessionId') as string) || 'unsorted';
  const sessionId = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = join('/tmp/dispatcher-uploads', sessionId);
  mkdirSync(dir, { recursive: true });

  const files = formData.getAll('files') as File[];
  if (!files.length || !(files[0] instanceof File)) {
    return Response.json({ error: 'No files uploaded' }, { status: 400 });
  }

  const refs = [];
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) continue;
    const id = randomUUID().slice(0, 8);
    const filename = `${id}-${file.name}`;
    const filePath = join(dir, filename);
    const buffer = Buffer.from(await file.arrayBuffer());
    writeFileSync(filePath, buffer);
    refs.push({ id, name: file.name, mimeType: file.type, path: filePath, size: file.size });
  }

  if (!refs.length) {
    return Response.json({ error: 'All files exceeded 25 MB limit' }, { status: 413 });
  }

  return Response.json({ files: refs });
}
