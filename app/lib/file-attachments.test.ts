import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES, addAttachmentFiles } from './file-attachments';

describe('addAttachmentFiles', () => {
  it('keeps valid files and reports files over 25 MB', () => {
    const valid = new File(['ok'], 'notes.txt', { type: 'text/plain' });
    const oversized = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'movie.mov');

    const result = addAttachmentFiles([], [valid, oversized]);

    expect(result.files.map((f) => f.name)).toEqual(['notes.txt']);
    expect(result.errors).toEqual(['movie.mov exceeds the 25 MB limit']);
  });

  it('accepts a file exactly at the 25 MB limit', () => {
    const file = new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], 'archive.zip');

    expect(addAttachmentFiles([], [file])).toEqual({ files: [file], errors: [] });
  });

  it('deduplicates files with the same browser identity', () => {
    const first = new File(['same'], 'photo.png', { type: 'image/png', lastModified: 10 });
    const duplicate = new File(['same'], 'photo.png', { type: 'image/png', lastModified: 10 });

    expect(addAttachmentFiles([first], [duplicate]).files).toEqual([first]);
  });
});
