import { describe, expect, it } from 'vitest';
import { isCompactCommand, parseAppCommands } from './slash-commands';

describe('parseAppCommands', () => {
  it('returns the message unchanged when it has no app commands', () => {
    expect(parseAppCommands('great! /merge /qa')).toEqual({ text: 'great! /merge /qa', column: null });
    expect(parseAppCommands('no commands here')).toEqual({ text: 'no commands here', column: null });
  });

  it('strips a trailing /archive and reports the column', () => {
    expect(parseAppCommands('great! /merge /qa /archive')).toEqual({ text: 'great! /merge /qa', column: 'archive' });
  });

  it('handles a command-only message', () => {
    expect(parseAppCommands('/done')).toEqual({ text: '', column: 'done' });
    expect(parseAppCommands('  /archive  ')).toEqual({ text: '', column: 'archive' });
  });

  it('strips commands mid-sentence without leaving doubled spaces', () => {
    expect(parseAppCommands('great /done thanks')).toEqual({ text: 'great thanks', column: 'done' });
  });

  it('lets the last command win', () => {
    expect(parseAppCommands('/done one more pass then /archive')).toEqual({ text: 'one more pass then', column: 'archive' });
  });

  it('does not consume paths or longer tokens', () => {
    const r = parseAppCommands('check /archive/2024 and /done-x and /doner');
    expect(r.column).toBeNull();
    expect(r.text).toBe('check /archive/2024 and /done-x and /doner');
  });

  it('requires whitespace before the slash', () => {
    expect(parseAppCommands('see and/or /archive').column).toBe('archive');
    expect(parseAppCommands('path/to/archive').column).toBeNull();
  });

  it('ignores commands inside inline code and fenced blocks', () => {
    expect(parseAppCommands('run `/archive` now').column).toBeNull();
    expect(parseAppCommands('```\n/done\n```').column).toBeNull();
  });

  it('is case-sensitive like skill commands', () => {
    expect(parseAppCommands('/Archive').column).toBeNull();
  });
});

describe('isCompactCommand', () => {
  it('matches /compact with or without trailing args', () => {
    expect(isCompactCommand('/compact')).toBe(true);
    expect(isCompactCommand('/compact now')).toBe(true);
  });

  it('rejects compact mid-sentence', () => {
    expect(isCompactCommand('please /compact')).toBe(false);
  });
});
