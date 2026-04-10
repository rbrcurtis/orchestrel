import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseSlashCommand,
  resolveSkillPath,
  renderSkill,
  expandSlashCommand,
} from '../skill-resolver';

const TMP = join(tmpdir(), 'skill-resolver-test-' + Date.now());

beforeAll(() => {
  // Project skill
  mkdirSync(join(TMP, 'project', '.claude', 'skills', 'ask'), { recursive: true });
  writeFileSync(
    join(TMP, 'project', '.claude', 'skills', 'ask', 'SKILL.md'),
    '---\nname: ask\ndescription: Answer questions\n---\n\nAnswer this: $ARGUMENTS\n',
  );

  // Project skill with positional args
  mkdirSync(join(TMP, 'project', '.claude', 'skills', 'migrate'), { recursive: true });
  writeFileSync(
    join(TMP, 'project', '.claude', 'skills', 'migrate', 'SKILL.md'),
    '---\nname: migrate\n---\n\nMigrate $0 from $1 to $2\n',
  );

  // Legacy command
  mkdirSync(join(TMP, 'project', '.claude', 'commands'), { recursive: true });
  writeFileSync(
    join(TMP, 'project', '.claude', 'commands', 'legacy.md'),
    '---\nname: legacy\n---\n\nLegacy command: $ARGUMENTS\n',
  );

  // Skill without $ARGUMENTS
  mkdirSync(join(TMP, 'project', '.claude', 'skills', 'noargs'), { recursive: true });
  writeFileSync(
    join(TMP, 'project', '.claude', 'skills', 'noargs', 'SKILL.md'),
    '---\nname: noargs\n---\n\nDo the thing.\n',
  );
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('parseSlashCommand', () => {
  it('parses command with args', () => {
    expect(parseSlashCommand('/ask what is this')).toEqual({
      name: 'ask',
      args: 'what is this',
    });
  });

  it('parses command without args', () => {
    expect(parseSlashCommand('/compact')).toEqual({ name: 'compact', args: '' });
  });

  it('returns null for non-slash prompts', () => {
    expect(parseSlashCommand('just a regular prompt')).toBeNull();
  });

  it('handles namespaced commands', () => {
    expect(parseSlashCommand('/superpowers:brainstorm build a thing')).toEqual({
      name: 'superpowers:brainstorm',
      args: 'build a thing',
    });
  });

  it('trims whitespace', () => {
    expect(parseSlashCommand('  /ask  hello  ')).toEqual({
      name: 'ask',
      args: 'hello',
    });
  });
});

describe('resolveSkillPath', () => {
  it('finds project-level skills', () => {
    const cwd = join(TMP, 'project');
    const result = resolveSkillPath('ask', cwd);
    expect(result).toBe(join(cwd, '.claude', 'skills', 'ask', 'SKILL.md'));
  });

  it('finds legacy commands', () => {
    const cwd = join(TMP, 'project');
    const result = resolveSkillPath('legacy', cwd);
    expect(result).toBe(join(cwd, '.claude', 'commands', 'legacy.md'));
  });

  it('returns null for unknown skills', () => {
    expect(resolveSkillPath('nonexistent', join(TMP, 'project'))).toBeNull();
  });
});

describe('renderSkill', () => {
  it('strips frontmatter and substitutes $ARGUMENTS', () => {
    const raw = '---\nname: ask\n---\n\nAnswer this: $ARGUMENTS\n';
    const result = renderSkill(raw, 'what is life', '/tmp', '/tmp');
    expect(result).toBe('Answer this: what is life\n');
  });

  it('substitutes positional args', () => {
    const raw = '---\nname: migrate\n---\n\nMigrate $0 from $1 to $2\n';
    const result = renderSkill(raw, 'users postgres mysql', '/tmp', '/tmp');
    expect(result).toBe('Migrate users from postgres to mysql\n');
  });

  it('handles quoted positional args', () => {
    const raw = '---\nname: test\n---\n\nFirst: $0 Second: $1\n';
    const result = renderSkill(raw, '"multi word" arg2', '/tmp', '/tmp');
    expect(result).toBe('First: multi word Second: arg2\n');
  });

  it('appends ARGUMENTS if $ARGUMENTS not in template', () => {
    const raw = '---\nname: noargs\n---\n\nDo the thing.\n';
    const result = renderSkill(raw, 'some extra context', '/tmp', '/tmp');
    expect(result).toBe('Do the thing.\n\n\nARGUMENTS: some extra context');
  });

  it('does not append ARGUMENTS if args are empty', () => {
    const raw = '---\nname: noargs\n---\n\nDo the thing.\n';
    const result = renderSkill(raw, '', '/tmp', '/tmp');
    expect(result).toBe('Do the thing.\n');
  });

  it('substitutes ${CLAUDE_SKILL_DIR}', () => {
    const raw = '---\nname: test\n---\n\nRead ${CLAUDE_SKILL_DIR}/helper.md\n';
    const result = renderSkill(raw, '', '/tmp', '/home/user/.claude/skills/test');
    expect(result).toBe('Read /home/user/.claude/skills/test/helper.md\n');
  });
});

describe('expandSlashCommand', () => {
  it('expands a project skill', () => {
    const cwd = join(TMP, 'project');
    const result = expandSlashCommand('/ask what is this function', cwd);
    expect(result).toBe('Answer this: what is this function\n');
  });

  it('returns original prompt for non-slash input', () => {
    const result = expandSlashCommand('just fix the bug', join(TMP, 'project'));
    expect(result).toBe('just fix the bug');
  });

  it('returns original prompt for unknown command', () => {
    const result = expandSlashCommand('/unknown do something', join(TMP, 'project'));
    expect(result).toBe('/unknown do something');
  });
});
