import { resolve, sep } from 'path';
import type { FileRef } from '../../shared/ws-protocol';

/** Prepend file-path instructions to a prompt when files are attached. */
export function buildPromptWithFiles(message: string, files?: FileRef[]): string {
  if (!files?.length) {
    console.log(`[sessions:manager] buildPromptWithFiles: no files attached, returning message as-is`);
    return message;
  }
  const roots = ['/tmp/orchestrel-uploads', '/tmp/orchestrel-attachments'].map((root) => `${resolve(root)}${sep}`);
  for (const f of files) {
    const path = resolve(f.path);
    if (!roots.some((root) => path.startsWith(root))) {
      throw new Error(`Invalid file path: ${f.path}`);
    }
  }
  const fileList = files.map((f) => `- ${f.path} (${f.name}, ${f.mimeType})`).join('\n');
  return `I've attached the following files for you to review. Use the Read tool to read them:\n${fileList}\n\n${message}`;
}
