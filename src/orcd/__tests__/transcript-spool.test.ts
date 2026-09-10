import { expect, it } from 'vitest';
import { TranscriptSpool } from '../transcript-spool';
import { TranscriptSync } from '../transcript-sync';

it('moves completed live records out of RAM without losing their order', () => {
  const sync = new TranscriptSync('bounded', [], 16);
  try {
    for (let i = 0; i < 180; i++) {
      const message = { role: 'user' as const, content: `message-${i}`, timestamp: i };
      sync.accept({ type: 'message_start', message });
      sync.accept({ type: 'message_end', message });
      sync.boundLiveState();
    }
    const snapshot = sync.snapshot();
    expect(snapshot.state.overlay).toHaveLength(120);
    expect(snapshot.state.spooled).toBe(60);
    expect(sync.pageCompleted().messages).toHaveLength(60);
    expect(sync.pageCompleted().messages[0].message).toMatchObject({ content: 'message-0' });
    expect(snapshot.state.overlay[0].message).toMatchObject({ content: 'message-60' });
  } finally {
    sync.dispose();
  }
});

it('pages completed live messages backwards without merging identical text or exceeding page budgets', () => {
  const spool = new TranscriptSpool();
  try {
    for (let i = 0; i < 10; i++) {
      spool.append({
        lifecycleId: `stream:${i}`,
        startSequence: i,
        message: { role: 'user', content: 'same prompt', timestamp: 1 },
        toolInput: {},
      });
    }
    const newest = spool.page(undefined, 3);
    expect(newest.messages.map((m) => m.lifecycleId)).toEqual(['stream:7', 'stream:8', 'stream:9']);
    expect(newest.before).toBe(7);
    expect(newest.hasOlder).toBe(true);
    const older = spool.page(newest.before, 2);
    expect(older.messages.map((m) => m.lifecycleId)).toEqual(['stream:5', 'stream:6']);
    expect(spool.page(1).hasOlder).toBe(false);
    expect(spool.page(0).messages).toEqual([]);
    // Oversized records remain whole, but only one is returned.
    expect(spool.page(undefined, 80, 1).messages).toHaveLength(1);
    expect(() => spool.page(11)).toThrow('Invalid transcript spool cursor');
  } finally {
    spool.dispose();
  }
  expect(() => spool.page()).toThrow('closed');
  spool.dispose();
});
