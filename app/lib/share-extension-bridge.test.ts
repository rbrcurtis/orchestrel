import { describe, expect, it } from 'vitest';
import { assembleSharedFile, type ShareBridgeTransport } from './share-extension-bridge';

describe('assembleSharedFile', () => {
  it('assembles ordered native chunks into the original file', async () => {
    const source = new TextEncoder().encode('shared attachment');
    const transport: ShareBridgeTransport = {
      readChunk: async (_fileId, offset, length) => {
        const bytes = source.slice(offset, offset + length);
        return { offset, bytes, done: offset + bytes.length >= source.length };
      },
    };

    const file = await assembleSharedFile(transport, {
      id: 'file-1',
      name: 'note.txt',
      mimeType: 'text/plain',
      size: source.length,
    }, 5);

    expect(file.name).toBe('note.txt');
    expect(file.type).toBe('text/plain');
    expect(await file.text()).toBe('shared attachment');
  });

  it('rejects a chunk returned at the wrong offset', async () => {
    const transport: ShareBridgeTransport = {
      readChunk: async () => ({ offset: 3, bytes: new Uint8Array([1]), done: true }),
    };

    await expect(assembleSharedFile(transport, {
      id: 'file-1',
      name: 'bad.bin',
      mimeType: 'application/octet-stream',
      size: 1,
    })).rejects.toThrow('Unexpected file chunk offset');
  });
});
