import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadUserPrefs, prefsSystemBlock, resolvePrefEmail } from './preferences';

const HUMAN = { userId: 1, email: 'wednesday@gmail.com', kind: 'human' as const };
const SYSTEM = { userId: 0, email: 'system', kind: 'system' as const };

describe('resolvePrefEmail', () => {
  it('uses a human author\'s email', () => {
    expect(resolvePrefEmail(HUMAN, 'default@example.com')).toBe('wednesday@gmail.com');
  });

  it('falls back to the node default for system or absent authors', () => {
    expect(resolvePrefEmail(SYSTEM, 'default@example.com')).toBe('default@example.com');
    expect(resolvePrefEmail(undefined, 'default@example.com')).toBe('default@example.com');
  });

  it('returns undefined when neither applies', () => {
    expect(resolvePrefEmail(undefined, undefined)).toBeUndefined();
  });
});

describe('loadUserPrefs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orc-prefs-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the user\'s file and returns undefined for a missing or blank one', () => {
    writeFileSync(join(dir, 'a@example.com.md'), 'lead with the answer (seen: 2026-10-06)\n');
    expect(loadUserPrefs('a@example.com', dir)).toBe('lead with the answer (seen: 2026-10-06)');
    expect(loadUserPrefs('missing@example.com', dir)).toBeUndefined();
    writeFileSync(join(dir, 'blank@example.com.md'), '  \n');
    expect(loadUserPrefs('blank@example.com', dir)).toBeUndefined();
  });
});

describe('prefsSystemBlock', () => {
  const PREFS = 'terse answers (seen: 2026-10-06)';

  it('labels the prefs as a persistent system-prompt section', () => {
    const block = prefsSystemBlock(PREFS);
    expect(block.startsWith('## User preferences')).toBe(true);
    expect(block).toContain(PREFS);
    // The prefs are instruction-shaped, never message content.
    expect(block).not.toContain('fix the bug');
  });
});
