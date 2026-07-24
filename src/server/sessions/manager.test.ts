import { describe, expect, it } from 'vitest';
import { buildPromptWithFiles } from './manager';

const file = {
  id: 'a',
  name: 'notes.txt',
  mimeType: 'text/plain',
  size: 3,
  path: '/tmp/orchestrel-attachments/42/a-notes.txt',
};

describe('buildPromptWithFiles', () => {
  it('includes staged node-local files in a prompt', () => {
    expect(buildPromptWithFiles('Review this', [file])).toContain(file.path);
  });

  it('rejects paths outside exact upload and staging roots', () => {
    expect(() => buildPromptWithFiles('x', [{ ...file, path: '/tmp/orchestrel-attachments-evil/a' }])).toThrow('Invalid file path');
    expect(() => buildPromptWithFiles('x', [{ ...file, path: '/etc/passwd' }])).toThrow('Invalid file path');
  });

  it('leaves prompts without files unchanged', () => {
    expect(buildPromptWithFiles('plain')).toBe('plain');
  });
});
