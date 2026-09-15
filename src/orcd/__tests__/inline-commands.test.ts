import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { expandInlineCommands } from '../inline-commands';
import { INJECTED_COMMANDS_MARKER, stripInjectedCommands } from '../../shared/slash-commands';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skillFile(body: string): { filePath: string; baseDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrel-inline-'));
  dirs.push(dir);
  const filePath = join(dir, 'SKILL.md');
  writeFileSync(filePath, `---\nname: skill\n---\n${body}`);
  return { filePath, baseDir: dir };
}

function fakeSession(skills: unknown[], prompts: unknown[]): AgentSession {
  return {
    resourceLoader: {
      getSkills: () => ({ skills }),
      getPrompts: () => ({ prompts }),
    },
  } as unknown as AgentSession;
}

describe('expandInlineCommands', () => {
  it('keeps the command verbatim and substitutes args into the injected template', () => {
    const session = fakeSession([], [{ name: 'pr', content: 'Target `$ARGUMENTS`.' }]);

    const out = expandInlineCommands(session, 'then /pr(dev) please');

    expect(out.startsWith('then /pr(dev) please')).toBe(true);
    expect(out).toContain(INJECTED_COMMANDS_MARKER);
    expect(out).toContain('Target `dev`.');
    expect(stripInjectedCommands(out)).toBe('then /pr(dev) please');
  });

  it('injects a skill body and keeps the invocation in place', () => {
    const { filePath, baseDir } = skillFile('Merge the branch.');
    const session = fakeSession([{ name: 'merge', filePath, baseDir }], []);

    const out = expandInlineCommands(session, '/merge(dev) now');

    expect(out.startsWith('/merge(dev) now')).toBe(true);
    expect(out).toContain(`<skill name="merge" location="${filePath}">`);
    expect(out).toContain('Merge the branch.');
    expect(stripInjectedCommands(out)).toBe('/merge(dev) now');
  });

  it('leaves commands inside code regions and unknown commands alone', () => {
    const session = fakeSession([], [{ name: 'pr', content: 'Target `$ARGUMENTS`.' }]);

    const text = 'run `/pr(dev)` and /unknown(dev)';
    expect(expandInlineCommands(session, text)).toBe(text);
  });

  it('returns the original string when nothing is recognized', () => {
    const session = fakeSession([], []);
    expect(expandInlineCommands(session, 'no commands here')).toBe('no commands here');
  });
});
