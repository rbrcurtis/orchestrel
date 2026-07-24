import { z } from 'zod';
import { fileRefSchema, type FileRef } from '../../src/shared/ws-protocol';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function fileKey(file: File): string {
  return `${file.name}\0${file.size}\0${file.type}\0${file.lastModified}`;
}

export function addAttachmentFiles(current: File[], incoming: File[]): { files: File[]; errors: string[] } {
  const files = [...current];
  const errors: string[] = [];
  const seen = new Set(current.map(fileKey));

  for (const file of incoming) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`${file.name} exceeds the 25 MB limit`);
      continue;
    }

    const key = fileKey(file);
    if (seen.has(key)) continue;
    files.push(file);
    seen.add(key);
  }

  return { files, errors };
}

export async function uploadFiles(
  files: File[],
  opts: { draftId?: string; sessionId?: string } = {},
): Promise<FileRef[]> {
  const form = new FormData();
  if (opts.draftId) form.append('draftId', opts.draftId);
  if (opts.sessionId) form.append('sessionId', opts.sessionId);
  for (const file of files) form.append('files', file);

  const res = await fetch('/api/upload', { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error : 'Upload failed');
  }

  const data = z.object({ files: z.array(fileRefSchema) }).parse(await res.json());
  return data.files;
}
