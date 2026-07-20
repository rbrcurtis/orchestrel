import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { effectiveAgentModels, resolveTierModelId, syncAgentOverrides } from '../subagent-agents';

const model = (modelID: string) => ({ label: modelID, modelID, contextWindow: 200000 });

describe('resolveTierModelId', () => {
  it('returns undefined when the provider has no models', () => {
    expect(resolveTierModelId({}, undefined, 'subagent')).toBeUndefined();
  });

  it('positional fallback: single model maps every tier to itself', () => {
    const models = { first: model('m1') };
    expect(resolveTierModelId(models, undefined, 'subagent')).toBe('m1');
    expect(resolveTierModelId(models, undefined, 'lightweight')).toBe('m1');
  });

  it('positional fallback: subagent is slot 2, lightweight is slot 3 (clamped)', () => {
    const two = { first: model('m1'), second: model('m2') };
    expect(resolveTierModelId(two, undefined, 'subagent')).toBe('m2');
    expect(resolveTierModelId(two, undefined, 'lightweight')).toBe('m2');
    const four = { ...two, third: model('m3'), fourth: model('m4') };
    expect(resolveTierModelId(four, undefined, 'subagent')).toBe('m2');
    expect(resolveTierModelId(four, undefined, 'lightweight')).toBe('m3');
  });

  it('aliases: resolves the tier key to its modelID', () => {
    const models = { big: model('big-id'), mid: model('mid-id'), small: model('small-id') };
    expect(resolveTierModelId(models, { subagent: 'mid', lightweight: 'small' }, 'subagent')).toBe('mid-id');
    expect(resolveTierModelId(models, { subagent: 'mid', lightweight: 'small' }, 'lightweight')).toBe('small-id');
  });

  it('aliases: missing or unknown tier key falls back to the first model', () => {
    const models = { big: model('big-id'), small: model('small-id') };
    expect(resolveTierModelId(models, { lightweight: 'small' }, 'subagent')).toBe('big-id');
    expect(resolveTierModelId(models, {}, 'subagent')).toBe('big-id');
    expect(resolveTierModelId(models, { subagent: 'nope' }, 'subagent')).toBe('big-id');
  });
});

describe('effectiveAgentModels', () => {
  it('maps general-purpose to slot 2 and Explore to slot 3 by default', () => {
    const models = { a: model('m1'), b: model('m2'), c: model('m3') };
    const map = effectiveAgentModels({ models });
    expect(map.get('general-purpose')).toBe('m2');
    expect(map.get('Explore')).toBe('m3');
    expect(map.size).toBe(2);
  });

  it('granular agents config overrides tier defaults and adds Plan', () => {
    const models = { big: model('big-id'), small: model('small-id') };
    const map = effectiveAgentModels({ models, agents: { Explore: 'big', Plan: 'small' } });
    expect(map.get('Explore')).toBe('big-id');
    expect(map.get('Plan')).toBe('small-id');
    expect(map.get('general-purpose')).toBe('small-id'); // slot 2 clamped
  });

  it('skips unknown agent names and falls back to first model for unknown keys', () => {
    const models = { big: model('big-id') };
    const map = effectiveAgentModels({ models, agents: { Nope: 'big', Plan: 'nope' } });
    expect(map.has('Nope')).toBe(false);
    expect(map.get('Plan')).toBe('big-id');
  });
});

describe('syncAgentOverrides', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orcd-agents-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const agentPath = (name: string) => join(dir, '.pi', 'agents', `${name}.md`);

  it('writes managed overrides for the default tier map', () => {
    const models = { main: model('k2'), lite: model('k2-lite') };
    syncAgentOverrides(dir, 'kimi', { models });
    const gp = readFileSync(agentPath('general-purpose'), 'utf-8');
    const explore = readFileSync(agentPath('Explore'), 'utf-8');
    expect(gp).toContain('model: kimi/k2-lite'); // slot 2 clamped to last of two
    expect(explore).toContain('model: kimi/k2-lite');
    expect(explore).toContain('managed_by: orchestrel');
  });

  it('never overwrites a user-authored agent file', () => {
    mkdirSync(join(dir, '.pi', 'agents'), { recursive: true });
    writeFileSync(agentPath('Explore'), '---\ndescription: mine\n---\ncustom prompt\n');
    syncAgentOverrides(dir, 'kimi', { models: { main: model('k2') } });
    expect(readFileSync(agentPath('Explore'), 'utf-8')).toContain('custom prompt');
  });

  it('rewrites its own managed file when the resolved model changes', () => {
    syncAgentOverrides(dir, 'kimi', { models: { main: model('k2') } });
    syncAgentOverrides(dir, 'anthropic', { models: { main: model('claude-haiku-4-5') } });
    expect(readFileSync(agentPath('Explore'), 'utf-8')).toContain('model: anthropic/claude-haiku-4-5');
  });

  it('removes stale managed files no longer in the effective map', () => {
    const models = { main: model('k2') };
    syncAgentOverrides(dir, 'kimi', { models, agents: { Plan: 'main' } });
    expect(existsSync(agentPath('Plan'))).toBe(true);
    syncAgentOverrides(dir, 'kimi', { models });
    expect(existsSync(agentPath('Plan'))).toBe(false);
    expect(existsSync(agentPath('Explore'))).toBe(true);
  });

  it('does nothing when the provider has no models', () => {
    syncAgentOverrides(dir, 'kimi', { models: {} });
    expect(existsSync(join(dir, '.pi', 'agents'))).toBe(false);
  });
});
