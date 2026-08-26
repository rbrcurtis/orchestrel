import { describe, expect, it } from 'vitest';
import { isCompactCommand, parseAppCommands } from './slash-commands';

describe('parseAppCommands', () => {
  it('returns the message unchanged when it has no app commands', () => {
    expect(parseAppCommands('great! /merge /qa')).toEqual({ text: 'great! /merge /qa', action: null });
    expect(parseAppCommands('no commands here')).toEqual({ text: 'no commands here', action: null });
  });

  it('strips a trailing /archive and reports the action', () => {
    expect(parseAppCommands('great! /merge /qa /archive')).toEqual({ text: 'great! /merge /qa', action: 'archive' });
  });

  it('reports /delete and strips surrounding text', () => {
    expect(parseAppCommands('cleanup /delete')).toEqual({ text: 'cleanup', action: 'delete' });
  });

  it('reports /ready', () => {
    expect(parseAppCommands('polish then /ready')).toEqual({ text: 'polish then', action: 'ready' });
  });

  it('handles a command-only message', () => {
    expect(parseAppCommands('/done')).toEqual({ text: '', action: 'done' });
    expect(parseAppCommands('  /archive  ')).toEqual({ text: '', action: 'archive' });
    expect(parseAppCommands('/ready')).toEqual({ text: '', action: 'ready' });
    expect(parseAppCommands('/delete')).toEqual({ text: '', action: 'delete' });
  });

  it('strips commands mid-sentence without leaving doubled spaces', () => {
    expect(parseAppCommands('great /done thanks')).toEqual({ text: 'great thanks', action: 'done' });
  });

  it('lets the last command win', () => {
    expect(parseAppCommands('/done one more pass then /archive')).toEqual({ text: 'one more pass then', action: 'archive' });
    expect(parseAppCommands('/done then /delete')).toEqual({ text: 'then', action: 'delete' });
  });

  it('does not consume paths or longer tokens', () => {
    const r = parseAppCommands('check /archive/2024 and /done-x and /doner and /deleted and /delete-x and /readyx');
    expect(r.action).toBeNull();
    expect(r.text).toBe('check /archive/2024 and /done-x and /doner and /deleted and /delete-x and /readyx');
  });

  it('requires whitespace before the slash', () => {
    expect(parseAppCommands('see and/or /archive').action).toBe('archive');
    expect(parseAppCommands('path/to/delete').action).toBeNull();
  });

  it('ignores commands inside inline code and fenced blocks', () => {
    expect(parseAppCommands('run `/archive` now').action).toBeNull();
    expect(parseAppCommands('```\n/done\n```').action).toBeNull();
    expect(parseAppCommands('run `/delete` now').action).toBeNull();
  });

  it('is case-sensitive like skill commands', () => {
    expect(parseAppCommands('/Archive').action).toBeNull();
    expect(parseAppCommands('/Delete').action).toBeNull();
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
