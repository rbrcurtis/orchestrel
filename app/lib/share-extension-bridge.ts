export type SharedNativeFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

export type SharedNativeManifest = {
  version: 1;
  id: string;
  text: string;
  files: SharedNativeFile[];
  errors: string[];
};

export type ShareBridgeTransport = {
  readChunk(fileId: string, offset: number, length: number): Promise<{
    offset: number;
    bytes: Uint8Array;
    done: boolean;
  }>;
};

type NativeHandler = { postMessage(message: unknown): void };
type PendingChunk = {
  resolve: (value: { offset: number; bytes: Uint8Array; done: boolean }) => void;
  reject: (error: Error) => void;
};

declare global {
  interface Window {
    webkit?: { messageHandlers?: { orchestrelShare?: NativeHandler } };
    __orchestrelShareReceive?: (message: unknown) => void;
  }
}

export async function assembleSharedFile(
  transport: ShareBridgeTransport,
  file: SharedNativeFile,
  chunkSize = 512 * 1024,
): Promise<File> {
  const parts: Uint8Array[] = [];
  let offset = 0;

  while (offset < file.size) {
    const chunk = await transport.readChunk(file.id, offset, Math.min(chunkSize, file.size - offset));
    if (chunk.offset !== offset) throw new Error('Unexpected file chunk offset');
    if (chunk.bytes.length === 0) throw new Error('Native file returned an empty chunk');
    parts.push(chunk.bytes);
    offset += chunk.bytes.length;
    if (chunk.done && offset !== file.size) throw new Error('Native file ended before its declared size');
  }

  return new File(parts as BlobPart[], file.name, { type: file.mimeType });
}

function decodeBase64(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function connectShareExtension(onManifest: (manifest: SharedNativeManifest) => void): ShareBridgeTransport | null {
  const handler = window.webkit?.messageHandlers?.orchestrelShare;
  if (!handler) return null;

  const pending = new Map<string, PendingChunk>();
  window.__orchestrelShareReceive = (value: unknown) => {
    if (!value || typeof value !== 'object' || !('type' in value)) return;
    const message = value as Record<string, unknown>;
    if (message.type === 'manifest') {
      onManifest(message.manifest as SharedNativeManifest);
      return;
    }
    if (message.type !== 'chunk' && message.type !== 'error') return;
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    if (message.type === 'error') {
      request.reject(new Error(typeof message.message === 'string' ? message.message : 'Native share failed'));
      return;
    }
    request.resolve({
      offset: Number(message.offset),
      bytes: decodeBase64(String(message.base64 ?? '')),
      done: Boolean(message.done),
    });
  };

  handler.postMessage({ type: 'ready' });
  return {
    readChunk(fileId, offset, length) {
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        handler.postMessage({ type: 'readChunk', requestId, fileId, offset, length });
      });
    },
  };
}

export function finishShare(type: 'complete' | 'cancel'): void {
  window.webkit?.messageHandlers?.orchestrelShare?.postMessage({ type });
}
