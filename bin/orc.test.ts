import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');
const tsxPath = resolve(repoRoot, 'node_modules/.bin/tsx');

describe('orc CLI provider/model defaults', () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orc-cli-test-'));
    configPath = join(dir, 'config.yaml');
    await writeFile(
      configPath,
      `
defaultProvider: anthropic
defaultModel: sonnet
providers:
  anthropic:
    models:
      opus: { label: Opus, modelID: claude-opus, contextWindow: 200000 }
      sonnet: { label: Sonnet, modelID: claude-sonnet, contextWindow: 200000 }
  trackable:
    baseUrl: http://127.0.0.1:3457
    apiKey: trackable
    models:
      sonnet: { label: Sonnet, modelID: trackable-sonnet, contextWindow: 200000 }
      auto: { label: Auto, modelID: auto, contextWindow: 200000 }
  chatgpt:
    models:
      gpt-5.5: { label: GPT-5.5, modelID: gpt-5.5, contextWindow: 400000 }
      gpt-5.4-mini: { label: GPT-5.4 Mini, modelID: gpt-5.4-mini, contextWindow: 400000 }
`,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses ORC_PROVIDER and ORC_MODEL when provider and model args are absent', async () => {
    const output = await runOrc([], {
      ORC_PROVIDER: 'trackable',
      ORC_MODEL: 'auto',
    });

    expect(output.provider).toBe('trackable');
    expect(output.modelAlias).toBe('auto');
    expect(output.modelID).toBe('auto');
    expect(output.cchArgs).toEqual(['--dangerously-skip-permissions', '--model', 'auto']);
  });

  it('lets positional provider and model args override ORC_PROVIDER and ORC_MODEL', async () => {
    const output = await runOrc(['anthropic', 'opus'], {
      ORC_PROVIDER: 'trackable',
      ORC_MODEL: 'auto',
    });

    expect(output.provider).toBe('anthropic');
    expect(output.modelAlias).toBe('opus');
    expect(output.modelID).toBe('claude-opus');
    expect(output.claudeArgs).toEqual([]);
  });

  it('falls back to the selected provider first model when ORC_MODEL does not exist there', async () => {
    const output = await runOrc(['chatgpt'], {
      ORC_PROVIDER: 'trackable',
      ORC_MODEL: 'auto',
    });

    expect(output.provider).toBe('chatgpt');
    expect(output.modelAlias).toBe('gpt-5.5');
    expect(output.modelID).toBe('gpt-5.5');
    expect(output.claudeArgs).toEqual([]);
  });

  it('uses ORC_MODEL with a positional provider when that model exists on the provider', async () => {
    const output = await runOrc(['trackable'], {
      ORC_PROVIDER: 'chatgpt',
      ORC_MODEL: 'auto',
    });

    expect(output.provider).toBe('trackable');
    expect(output.modelAlias).toBe('auto');
    expect(output.modelID).toBe('auto');
    expect(output.claudeArgs).toEqual([]);
  });

  async function runOrc(
    cliArgs: string[],
    env: Record<string, string | undefined>,
  ): Promise<Record<string, unknown>> {
    const { stdout } = await execFileAsync(
      tsxPath,
      ['bin/orc', '--config', configPath, '--print-env', ...cliArgs],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...env,
          ORC_CONFIG: undefined,
        },
      },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  }
});
