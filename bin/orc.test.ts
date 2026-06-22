import { execFile } from 'child_process';
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');
const tsxPath = resolve(repoRoot, 'node_modules/.bin/tsx');

describe('orc CLI provider/model defaults', () => {
  let dir: string;
  let configPath: string;
  let piPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orc-cli-test-'));
    configPath = join(dir, 'config.yaml');
    piPath = join(dir, 'pi');
    await writeFile(piPath, '#!/bin/sh\nexit 0\n');
    await chmod(piPath, 0o755);

    await writeFile(
      configPath,
      `
defaultProvider: anthropic
defaultModel: sonnet
providers:
  anthropic:
    type: anthropic
    apiKey: anthropic-key
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
    type: openai
    apiKey: openai-key
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
    expect(output.piArgs).toEqual(['--model', 'auto']);
  });

  it('lets positional provider and model args override ORC_PROVIDER and ORC_MODEL', async () => {
    const output = await runOrc(['anthropic', 'opus'], {
      ORC_PROVIDER: 'trackable',
      ORC_MODEL: 'auto',
    });

    expect(output.provider).toBe('anthropic');
    expect(output.modelAlias).toBe('opus');
    expect(output.modelID).toBe('claude-opus');
    expect(output.passthroughArgs).toEqual([]);
  });

  it('falls back to the selected provider first model when ORC_MODEL does not exist there', async () => {
    const output = await runOrc(['chatgpt'], {
      ORC_PROVIDER: 'trackable',
      ORC_MODEL: 'auto',
    });

    expect(output.provider).toBe('chatgpt');
    expect(output.modelAlias).toBe('gpt-5.5');
    expect(output.modelID).toBe('gpt-5.5');
    expect(output.passthroughArgs).toEqual([]);
  });

  it('uses ORC_MODEL with a positional provider when that model exists on the provider', async () => {
    const output = await runOrc(['trackable'], {
      ORC_PROVIDER: 'chatgpt',
      ORC_MODEL: 'auto',
    });

    expect(output.provider).toBe('trackable');
    expect(output.modelAlias).toBe('auto');
    expect(output.modelID).toBe('auto');
    expect(output.passthroughArgs).toEqual([]);
  });

  it('prints ORC_PI_PATH in print-env output when overridden', async () => {
    const customPiPath = join(dir, 'custom-pi');

    const output = await runOrc([], {
      ORC_PI_PATH: customPiPath,
    });

    expect(output.piPath).toBe(customPiPath);
  });

  it('strips legacy skip permissions flag from pi args', async () => {
    const output = await runOrc(['--dangerously-skip-permissions', 'trackable', 'auto'], {});

    expect(output.passthroughArgs).toEqual([]);
    expect(output.piArgs).toEqual(['--model', 'auto']);
  });

  it('maps provider typed API keys to Pi-native env vars', async () => {
    const anthropicOutput = await runOrc(['anthropic', 'sonnet'], {});
    const openaiOutput = await runOrc(['chatgpt', 'gpt-5.5'], {});

    expect(readEnv(anthropicOutput).PI_API_KEY).toBe('anthropic-key');
    expect(readEnv(anthropicOutput).ANTHROPIC_API_KEY).toBe('anthropic-key');
    expect(readEnv(openaiOutput).PI_API_KEY).toBe('openai-key');
    expect(readEnv(openaiOutput).OPENAI_API_KEY).toBe('openai-key');
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
          ORC_PI_PATH: env.ORC_PI_PATH ?? piPath,
        },
      },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  }

  function readEnv(output: Record<string, unknown>): Record<string, string> {
    if (!output.env || typeof output.env !== 'object' || Array.isArray(output.env)) {
      throw new Error('print-env output is missing env object');
    }
    return output.env as Record<string, string>;
  }
});
