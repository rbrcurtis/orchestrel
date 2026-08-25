import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSubagentPolicy,
  cleanupManagedSubagentFiles,
  parseSubagentPolicy,
  serializeSubagentPolicy,
} from './subagent-policy';

const model = (modelID: string) => ({ label: modelID, modelID, contextWindow: 200000 });

describe('buildSubagentPolicy', () => {
  it('maps aliases and granular overrides to fully qualified models', () => {
    expect(buildSubagentPolicy('chatgpt', 'gpt-5.5', {
      models: {
        main: model('gpt-5.5'),
        mini: model('gpt-5.4-mini'),
        nano: model('gpt-5.4-nano'),
      },
      aliases: { subagent: 'mini', lightweight: 'nano' },
      agents: { Plan: 'main' },
    })).toMatchObject({
      parentProvider: 'chatgpt',
      parentModel: 'chatgpt/gpt-5.5',
      parentModels: ['main', 'gpt-5.5', 'mini', 'gpt-5.4-mini', 'nano', 'gpt-5.4-nano'],
      agents: {
        'general-purpose': { model: 'chatgpt/gpt-5.4-mini', source: 'subagent tier' },
        Explore: { model: 'chatgpt/gpt-5.4-nano', source: 'lightweight tier' },
        Plan: { model: 'chatgpt/gpt-5.5', source: 'agent override' },
      },
      allowCrossProvider: false,
    });
  });

  it('uses positional fallback and parent model for Plan', () => {
    expect(buildSubagentPolicy('kimi', 'main-id', {
      models: {
        main: model('main-id'),
        worker: model('worker-id'),
        small: model('small-id'),
      },
    }).agents).toEqual({
      'general-purpose': { model: 'kimi/worker-id', source: 'subagent tier' },
      Explore: { model: 'kimi/small-id', source: 'lightweight tier' },
      Plan: { model: 'kimi/main-id', source: 'parent model' },
    });
  });

  it('uses positional fallback for a tier with no configured alias', () => {
    expect(buildSubagentPolicy('kimi', 'main-id', {
      models: {
        main: model('main-id'),
        worker: model('worker-id'),
        small: model('small-id'),
      },
      aliases: { subagent: 'main' },
    }).agents).toMatchObject({
      'general-purpose': { model: 'kimi/main-id', source: 'subagent tier' },
      Explore: { model: 'kimi/small-id', source: 'lightweight tier' },
    });
  });

  it('throws for a configured unknown agent model key', () => {
    expect(() => buildSubagentPolicy('trackable', 'auto', {
      models: { main: model('auto') },
      agents: { Explore: 'missing' },
    })).toThrow('unknown model key "missing" for agent "Explore"');
  });
});

describe('subagent policy serialization', () => {
  it('round-trips a valid policy and rejects cross-provider policies', () => {
    const policy = buildSubagentPolicy('kimi', 'main-id', { models: { main: model('main-id') } });
    expect(parseSubagentPolicy(serializeSubagentPolicy(policy))).toEqual(policy);
    expect(() => parseSubagentPolicy(JSON.stringify({ ...policy, allowCrossProvider: true }))).toThrow(
      'allowCrossProvider must be false',
    );
  });

  it('rejects missing, empty, and malformed parentModels', () => {
    const policy = buildSubagentPolicy('kimi', 'main-id', { models: { main: model('main-id') } });

    expect(() => parseSubagentPolicy(JSON.stringify({ ...policy, parentModels: undefined }))).toThrow(
      'subagent policy parentModels must be a non-empty array',
    );
    expect(() => parseSubagentPolicy(JSON.stringify({ ...policy, parentModels: [] }))).toThrow(
      'subagent policy parentModels must be a non-empty array',
    );
    expect(() => parseSubagentPolicy(JSON.stringify({ ...policy, parentModels: ['main', 42] }))).toThrow(
      'subagent policy parentModels[1] must be a non-empty string',
    );
  });

  it('rejects bare and cross-provider parent and agent models', () => {
    const policy = buildSubagentPolicy('kimi', 'main-id', { models: { main: model('main-id') } });

    expect(() => parseSubagentPolicy(JSON.stringify({ ...policy, parentModel: 'main-id' }))).toThrow(
      'subagent policy parentModel must be a fully qualified provider/modelID',
    );
    expect(() => parseSubagentPolicy(JSON.stringify({ ...policy, parentModel: 'other/main-id' }))).toThrow(
      'subagent policy parentModel provider must equal parentProvider "kimi"',
    );
    expect(() => parseSubagentPolicy(JSON.stringify({
      ...policy,
      agents: { Explore: { model: 'small-id', source: 'test' } },
    }))).toThrow('subagent policy agent "Explore" model must be a fully qualified provider/modelID');
    expect(() => parseSubagentPolicy(JSON.stringify({
      ...policy,
      agents: { Explore: { model: 'other/small-id', source: 'test' } },
    }))).toThrow('subagent policy agent "Explore" model provider must equal parentProvider "kimi"');
  });
});

describe('cleanupManagedSubagentFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orchestrel-policy-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes only Orchestrel-managed agent files and prunes empty directories', () => {
    const agents = join(dir, '.pi', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'Explore.md'), '---\nmanaged_by: orchestrel\n---\n');
    writeFileSync(join(agents, 'Custom.md'), '---\ndescription: custom\n---\n');
    writeFileSync(join(dir, '.pi', 'settings.json'), '{}');

    cleanupManagedSubagentFiles(dir);

    expect(existsSync(join(agents, 'Explore.md'))).toBe(false);
    expect(readFileSync(join(agents, 'Custom.md'), 'utf-8')).toContain('custom');
    expect(readFileSync(join(dir, '.pi', 'settings.json'), 'utf-8')).toBe('{}');
    expect(existsSync(agents)).toBe(true);

    rmSync(join(agents, 'Custom.md'));
    cleanupManagedSubagentFiles(dir);
    expect(existsSync(agents)).toBe(false);
    expect(existsSync(join(dir, '.pi'))).toBe(true);
  });

  it('keeps an unmarked file whose body mentions the managed marker', () => {
    const agents = join(dir, '.pi', 'agents');
    mkdirSync(agents, { recursive: true });
    const custom = join(agents, 'Custom.md');
    writeFileSync(custom, '---\ndescription: custom\n---\nThe body mentions managed_by: orchestrel.');

    cleanupManagedSubagentFiles(dir);

    expect(readFileSync(custom, 'utf-8')).toContain('managed_by: orchestrel');
  });

  it('does not create .pi in a clean project', () => {
    cleanupManagedSubagentFiles(dir);
    expect(existsSync(join(dir, '.pi'))).toBe(false);
  });
});
