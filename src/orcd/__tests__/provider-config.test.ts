import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readProviderFile, saveProviderFile, validateProviders } from '../provider-config';

const CONFIG = `# a comment the writer must keep
listen: { host: 127.0.0.1, port: 7420 }
authToken: tok
name: local
defaultProvider: old
defaultModel: oldmodel
ringBufferSize: 5000
providers:
  old:
    label: Old
    baseUrl: https://old.example
    apiKey: \${OLD_KEY}
    models:
      oldmodel: { label: Old, modelID: old-model, contextWindow: 200000 }
memory:
  mode: stage
  provider: old
  model: oldmodel
  projects: {}
`;

const providers = {
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '${ANTHROPIC_API_KEY}',
    models: { sonnet: { label: 'Sonnet', modelID: 'claude-sonnet-4-6', contextWindow: 1000000 } },
  },
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orcd-providers-'));
  file = join(dir, 'orcd.yaml');
  writeFileSync(file, CONFIG, { mode: 0o600 });
  process.env.ORC_CONFIG = file;
});

afterEach(() => {
  delete process.env.ORC_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

describe('readProviderFile', () => {
  it('returns raw definitions with ${ENV} templates unresolved', () => {
    const snap = readProviderFile();
    expect(snap.configPath).toBe(file);
    expect(snap.defaultProvider).toBe('old');
    expect(snap.providers.old).toMatchObject({ label: 'Old', apiKey: '${OLD_KEY}' });
  });

  it('reports an empty map when the config has no providers yet', () => {
    writeFileSync(file, 'listen: { host: 127.0.0.1, port: 7420 }\nauthToken: tok\n');
    expect(readProviderFile().providers).toEqual({});
  });
});

describe('saveProviderFile', () => {
  it('writes providers and defaults, leaving the rest of the document intact', () => {
    const saved = saveProviderFile({ providers, defaultProvider: 'anthropic', defaultModel: 'sonnet' });

    expect(saved.configPath).toBe(file);
    expect(saved.config.providers.anthropic?.models.sonnet?.modelID).toBe('claude-sonnet-4-6');

    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# a comment the writer must keep');
    expect(text).toContain('ringBufferSize: 5000');
    expect(text).toContain('memory:');
    expect(text).toContain('mode: stage');
    expect(text).toContain('defaultProvider: anthropic');
    expect(text).toContain('defaultModel: sonnet');
    expect(text).not.toContain('old-model');
  });

  it('keeps the file private and leaves no temp file behind', () => {
    saveProviderFile({ providers, defaultProvider: 'anthropic', defaultModel: 'sonnet' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['orcd.yaml']);
  });

  it('writes through a symlinked config path instead of replacing the link', () => {
    const link = join(dir, 'config.yaml');
    symlinkSync('orcd.yaml', link);
    process.env.ORC_CONFIG = link;

    const saved = saveProviderFile({ providers, defaultProvider: 'anthropic', defaultModel: 'sonnet' });

    expect(saved.configPath).toBe(file);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('defaultProvider: anthropic');
  });

  it('rejects an invalid provider map without touching the file', () => {
    expect(() =>
      saveProviderFile({
        providers: { broken: { baseUrl: '', models: { sonnet: { label: 'S' } } } },
        defaultProvider: 'broken',
        defaultModel: 'missing',
      }),
    ).toThrow(/needs a modelID/);
    expect(readFileSync(file, 'utf8')).toBe(CONFIG);
  });
});

describe('validateProviders', () => {
  const ok = { providers, defaultProvider: 'anthropic', defaultModel: 'sonnet' };

  it('accepts a complete provider map', () => {
    expect(validateProviders(ok)).toEqual([]);
  });

  it('requires a model list', () => {
    const problems = validateProviders({ ...ok, providers: { anthropic: { baseUrl: 'https://x', models: {} } } });
    expect(problems.join('\n')).toMatch(/at least one model/);
  });

  it('requires a baseUrl unless the provider uses an oauth extension', () => {
    const noUrl = validateProviders({
      ...ok,
      providers: { anthropic: { models: { sonnet: { modelID: 'm', contextWindow: 1000 } } } },
    });
    expect(noUrl.join('\n')).toMatch(/needs a baseUrl/);

    const oauth = validateProviders({
      ...ok,
      providers: { anthropic: { oauth: 'claude-max', models: { sonnet: { modelID: 'm', contextWindow: 1000 } } } },
    });
    expect(oauth).toEqual([]);
  });

  it('catches dangling defaults, tiers and agent overrides', () => {
    expect(validateProviders({ ...ok, defaultProvider: 'nope' }).join('\n')).toMatch(/not one of the configured/);
    expect(validateProviders({ ...ok, defaultModel: 'nope' }).join('\n')).toMatch(/not one of "anthropic"'s models/);

    const tiers = validateProviders({
      ...ok,
      providers: {
        anthropic: {
          ...providers.anthropic,
          aliases: { subagent: 'ghost' },
          agents: { Explore: 'sonnet' },
        },
      },
    });
    expect(tiers.join('\n')).toMatch(/subagent tier points at model "ghost"/);
  });

  it('allows clearing every provider', () => {
    expect(validateProviders({ providers: {}, defaultProvider: '', defaultModel: '' })).toEqual([]);
  });
});
