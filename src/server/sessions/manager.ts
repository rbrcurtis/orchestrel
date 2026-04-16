import { resolve } from 'path';
import type { FileRef } from '../../shared/ws-protocol';

/** Prepend file-path instructions to a prompt when files are attached. */
export function buildPromptWithFiles(message: string, files?: FileRef[]): string {
  if (!files?.length) {
    console.log(`[sessions:manager] buildPromptWithFiles: no files attached, returning message as-is`);
    return message;
  }
  for (const f of files) {
    if (!resolve(f.path).startsWith('/tmp/orchestrel-uploads/')) {
      throw new Error(`Invalid file path: ${f.path}`);
    }
  }
  const fileList = files.map((f) => `- ${f.path} (${f.name}, ${f.mimeType})`).join('\n');
  return `I've attached the following files for you to review. Use the Read tool to read them:\n${fileList}\n\n${message}`;
}
