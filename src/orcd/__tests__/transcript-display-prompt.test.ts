import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import { projectEntries } from '../transcript-sync';

// Regression: the live transcript snapshot projects raw persisted entries, so an
// expanded prompt template (which has no <skill> wrapper to collapse) leaked the
// whole template body after a page reload. The display metadata must win.
it('projects the original command instead of its expanded prompt template', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrel-transcript-display-'));
  try {
    const manager = SessionManager.create(dir);
    const expanded = 'Run the push workflow, then create a pull request targeting ``.';
    manager.appendCustomEntry('orchestrel-display-prompt', {
      displayText: '/pr',
      expandedHash: createHash('sha256').update(expanded).digest('hex'),
    });
    manager.appendMessage({ role: 'user', content: expanded, timestamp: Date.now() });

    const texts = projectEntries(manager.getEntries())
      .flatMap((entry) => entry.messages)
      .filter((message) => message.role === 'user')
      .map((message) => message.content);

    expect(texts).toContain('/pr');
    expect(texts).not.toContain(expanded);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
