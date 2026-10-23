import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import { TranscriptSync, projectEntries } from '../transcript-sync';
import { IMAGE_OMITTED_TEXT } from '../../shared/transcript-media';

const INLINE_IMAGE = 'iVBORw0KGgo'.repeat(20_000); // ~220 KB of base64

async function withManager(fn: (manager: SessionManager) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrel-transcript-media-'));
  try {
    await fn(SessionManager.create(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function appendImageTurn(manager: SessionManager): void {
  manager.appendMessage({
    role: 'user',
    content: [
      { type: 'text', text: 'what is on this bike?' },
      { type: 'image', data: INLINE_IMAGE, mimeType: 'image/png' },
    ],
    timestamp: Date.now(),
  });
}

// Photos are persisted as base64 inside the session file. They are never rendered,
// but a 43-image session put 45 MB of them into every snapshot and every settle, which
// stalled the backend for seconds per copy (and before that, per 64 KB chunk).
it('projects messages and entries without inline image data', async () => {
  await withManager((manager) => {
    appendImageTurn(manager);

    const projected = projectEntries(manager.getEntries());
    const json = JSON.stringify(projected);

    expect(json).not.toContain(INLINE_IMAGE.slice(0, 64));
    expect(json).toContain(IMAGE_OMITTED_TEXT);
    expect(json).toContain('what is on this bike?');
  });
});

it('redacts image data from snapshots and from settle baselines', async () => {
  await withManager((manager) => {
    appendImageTurn(manager);
    const sync = new TranscriptSync('stream-media', manager.getEntries(), 512, 1_048_576);

    const snapshot = JSON.stringify(sync.snapshot());
    const settled = JSON.stringify(sync.settle(manager.getEntries()));

    expect(snapshot).not.toContain(INLINE_IMAGE.slice(0, 64));
    expect(settled).not.toContain(INLINE_IMAGE.slice(0, 64));
    expect(settled).toContain(IMAGE_OMITTED_TEXT);
  });
});

it('caps the baseline at the recent tail instead of shipping every entry', async () => {
  await withManager((manager) => {
    for (let i = 0; i < 200; i++) {
      manager.appendMessage({ role: 'user', content: `message ${i}`, timestamp: Date.now() });
    }
    const sync = new TranscriptSync('stream-cap', manager.getEntries(), 512, 1_048_576);
    const baseline = sync.snapshot().state.baseline;

    expect(baseline.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(baseline)).toContain('message 199');
    expect(JSON.stringify(baseline)).not.toContain('message 0"');
  });
});

it('keeps the baseline within the byte budget, always keeping the newest entry', async () => {
  await withManager((manager) => {
    for (let i = 0; i < 20; i++) {
      manager.appendMessage({ role: 'user', content: `${i}:${'x'.repeat(150_000)}`, timestamp: Date.now() });
    }
    const sync = new TranscriptSync('stream-bytes', manager.getEntries(), 512, 1_048_576);
    const baseline = sync.snapshot().state.baseline;

    expect(baseline.length).toBeGreaterThan(0);
    expect(baseline.length).toBeLessThan(20);
    expect(new TextEncoder().encode(JSON.stringify(baseline)).byteLength).toBeLessThan(1_200_000);
    expect(JSON.stringify(baseline.at(-1))).toContain('19:');
  });
});
