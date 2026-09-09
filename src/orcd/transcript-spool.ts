import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptOverlayMessage } from '../shared/transcript-sync';

// Completed live messages have no durable Pi entry association until settlement.
// Store them under their stream lifecycle identity, not a guessed history ID.
// Fixed-size disk index entries allow paging without retaining one RAM index per
// message. This is disposable display state, never authoritative session history.
export class TranscriptSpool {
  private readonly dir = mkdtempSync(join(tmpdir(), 'orcd-transcript-'));
  private readonly data = openSync(join(this.dir, 'messages'), 'wx+', 0o600);
  private readonly index = openSync(join(this.dir, 'index'), 'wx+', 0o600);
  private size = 0;
  private count = 0;
  private disposed = false;

  get length(): number { return this.count; }
  get bytes(): number { return this.size + this.count * 16; }

  append(message: TranscriptOverlayMessage): number {
    if (this.disposed) throw new Error('Transcript spool is closed');
    const record = Buffer.from(JSON.stringify(message));
    let written = 0;
    while (written < record.length) {
      const n = writeSync(this.data, record, written, record.length - written, this.size + written);
      if (n === 0) throw new Error('Transcript spool write made no progress');
      written += n;
    }
    const entry = Buffer.alloc(16);
    entry.writeDoubleLE(this.size, 0);
    entry.writeDoubleLE(record.length, 8);
    written = 0;
    while (written < entry.length) {
      const n = writeSync(this.index, entry, written, entry.length - written, this.count * 16 + written);
      if (n === 0) throw new Error('Transcript spool index write made no progress');
      written += n;
    }
    this.size += record.length;
    return this.count++;
  }

  // A page can exceed maxBytes only for its first record. This preserves a
  // single oversized message without truncating visible tool output.
  page(before = this.count, limit = 80, maxBytes = 1_048_576): {
    messages: TranscriptOverlayMessage[];
    before: number;
    hasOlder: boolean;
  } {
    if (this.disposed) throw new Error('Transcript spool is closed');
    if (!Number.isSafeInteger(before) || before < 0 || before > this.count) throw new Error('Invalid transcript spool cursor');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid transcript spool page limit');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid transcript spool byte limit');
    const messages: TranscriptOverlayMessage[] = [];
    let bytes = 0;
    let cursor = before;
    while (cursor > 0 && messages.length < limit) {
      const entry = Buffer.alloc(16);
      this.read(this.index, entry, (cursor - 1) * 16);
      const offset = entry.readDoubleLE(0);
      const length = entry.readDoubleLE(8);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 0 || offset + length > this.size) {
        throw new Error('Invalid transcript spool index');
      }
      if (messages.length > 0 && bytes + length > maxBytes) break;
      const record = Buffer.alloc(length);
      this.read(this.data, record, offset);
      messages.unshift(JSON.parse(record.toString()) as TranscriptOverlayMessage);
      bytes += length;
      cursor--;
    }
    return { messages, before: cursor, hasOlder: cursor > 0 };
  }

  dispose(): void {
    if (this.disposed) {
      console.debug('[transcript-spool] already disposed');
      return;
    }
    this.disposed = true;
    try {
      closeSync(this.data);
    } finally {
      try {
        closeSync(this.index);
      } finally {
        rmSync(this.dir, { recursive: true, force: true });
      }
    }
  }

  private read(fd: number, buffer: Buffer, position: number): void {
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
      if (n === 0) throw new Error('Incomplete transcript spool record');
      offset += n;
    }
  }
}
