import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../../shared/config';
import { isSyntheticEmail, loadPrefsBody, prefEmailFor, prefsForAuthor } from './user-prefs';

const HUMAN = { userId: 1, email: 'wednesday@gmail.com', kind: 'human' as const };
const LOCAL = { userId: 0, email: 'local', kind: 'human' as const };
const SYSTEM = { userId: 0, email: 'system', kind: 'system' as const };

describe('isSyntheticEmail', () => {
  it('treats the loopback admin, the system author and the desktop user as "no person"', () => {
    expect(isSyntheticEmail('local')).toBe(true);
    expect(isSyntheticEmail('system')).toBe(true);
    expect(isSyntheticEmail('local@orchestrel.local')).toBe(true);
    expect(isSyntheticEmail(undefined)).toBe(true);
  });

  it('treats a real address as a person', () => {
    expect(isSyntheticEmail('wednesday@gmail.com')).toBe(false);
  });
});

describe('prefEmailFor', () => {
  it("uses a human author's email", () => {
    expect(prefEmailFor(HUMAN, 'default@example.com')).toBe('wednesday@gmail.com');
  });

  it('falls back to the backend default for synthetic authors', () => {
    expect(prefEmailFor(LOCAL, 'default@example.com')).toBe('default@example.com');
    expect(prefEmailFor(SYSTEM, 'default@example.com')).toBe('default@example.com');
    expect(prefEmailFor(undefined, 'default@example.com')).toBe('default@example.com');
  });

  it('returns undefined when there is no person and no default', () => {
    expect(prefEmailFor(LOCAL, undefined)).toBeUndefined();
  });

  it('refuses an email that could escape the preference directory', () => {
    expect(prefEmailFor({ userId: 9, email: '../../etc/passwd@x', kind: 'human' }, undefined)).toBeUndefined();
    expect(prefEmailFor({ userId: 9, email: 'a/b@example.com', kind: 'human' }, undefined)).toBeUndefined();
  });
});

describe('loadPrefsBody', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be-prefs-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the body, trimming, and returns undefined for a missing or blank file', () => {
    writeFileSync(join(dir, 'a@example.com.md'), '\n lead with the answer (seen: 2026-10-06)\n');
    writeFileSync(join(dir, 'blank@example.com.md'), '   \n\n');
    expect(loadPrefsBody('a@example.com', dir)).toBe('lead with the answer (seen: 2026-10-06)');
    expect(loadPrefsBody('blank@example.com', dir)).toBeUndefined();
    expect(loadPrefsBody('missing@example.com', dir)).toBeUndefined();
  });
});

describe('prefsForAuthor', () => {
  const root = mkdtempSync(join(tmpdir(), 'be-prefs-cfg-'));
  const prefsDir = join(root, 'prefs');
  const cfgPath = join(root, 'config.yaml');
  const previousConfig = process.env.ORC_CONFIG;

  mkdirSync(prefsDir, { recursive: true });
  mkdirSync(join(root, 'stage'), { recursive: true });
  writeFileSync(
    cfgPath,
    `listen: { host: 0.0.0.0, port: 7420 }
authToken: tok
name: box
defaultProvider: p
defaultModel: m
defaultUser: default@example.com
providers:
  p:
    models:
      m: { label: "M", modelID: m, contextWindow: 1000 }
memory:
  mode: write
  provider: p
  model: m
  maxTurns: 1
  excerptTokens: 100
  settleMs: 1
  windowDays: 1
  stageDir: ${join(root, 'stage')}
  projects: {}
  preferences:
    dir: ${prefsDir}
`,
  );

  const useTestConfig = () => {
    process.env.ORC_CONFIG = cfgPath;
    resetConfigCache();
  };

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.ORC_CONFIG;
    else process.env.ORC_CONFIG = previousConfig;
    resetConfigCache();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("sends the acting user's file body from the backend's own copy", () => {
    writeFileSync(join(prefsDir, 'wednesday@gmail.com.md'), 'terse answers (seen: 2026-10-29)\n');
    useTestConfig();
    expect(prefsForAuthor(HUMAN)).toEqual({
      email: 'wednesday@gmail.com',
      body: 'terse answers (seen: 2026-10-29)',
    });
  });

  it('maps the synthetic local identity to the configured defaultUser', () => {
    writeFileSync(join(prefsDir, 'default@example.com.md'), 'default user prefs (seen: 2026-10-29)\n');
    useTestConfig();
    expect(prefsForAuthor(LOCAL)).toEqual({
      email: 'default@example.com',
      body: 'default user prefs (seen: 2026-10-29)',
    });
    expect(prefsForAuthor(SYSTEM)).toEqual({
      email: 'default@example.com',
      body: 'default user prefs (seen: 2026-10-29)',
    });
  });

  it('sends an empty body, not nothing, when the user has no file', () => {
    useTestConfig();
    expect(prefsForAuthor({ userId: 5, email: 'nofile@example.com', kind: 'human' })).toEqual({
      email: 'nofile@example.com',
      body: '',
    });
  });
});
