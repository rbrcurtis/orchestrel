import { execFile } from 'child_process';
import { createServer } from 'http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
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
  let stubOutputPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orc-cli-test-'));
    configPath = join(dir, 'config.yaml');
    piPath = join(dir, 'pi');
    stubOutputPath = join(dir, 'pi-output.json');
    await writeFile(
      piPath,
      `#!/bin/sh
node -e 'require("fs").writeFileSync(process.env.ORC_STUB_OUTPUT, JSON.stringify({args: process.argv.slice(1), env: {ORCHESTREL_SUBAGENT_POLICY: process.env.ORCHESTREL_SUBAGENT_POLICY}}))' -- "$@"
`,
    );
    await chmod(piPath, 0o755);

    await writeFile(
      configPath,
      `
name: import-node
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

  it('imports a session through the backend without launching Pi', async () => {
    const requests: Array<{ url?: string; body?: unknown }> = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      req.on('end', () => {
        requests.push({ url: req.url, body: JSON.parse(raw) as unknown })
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 42, title: 'Imported session' }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const cwd = await mkdtemp(join(tmpdir(), 'orc-import-cwd-'))
    try {
      const { stdout } = await execFileAsync(tsxPath, [resolve(repoRoot, 'bin/orc'), '--import', 'session-123', '--config', configPath], {
        cwd,
        env: {
          ...process.env,
          ORC_API_URL: `http://127.0.0.1:${port}`,
          ORC_PI_PATH: join(dir, 'does-not-exist'),
        },
      })

      expect(requests).toEqual([{ url: '/api/cards/import-session', body: { sessionId: 'session-123', path: await realpath(cwd), nodeName: 'import-node' } }])
      expect(stdout).toContain('Imported card 42: Imported session')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30000)

  it('prints the backend error when session import fails', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(422, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No project configured for path: /tmp/missing' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      await expect(execFileAsync(tsxPath, [resolve(repoRoot, 'bin/orc'), '--import', 'session-123'], {
        env: { ...process.env, ORC_API_URL: `http://127.0.0.1:${port}` },
      })).rejects.toMatchObject({ stderr: expect.stringContaining('No project configured for path: /tmp/missing') })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    }
  }, 30000)

  it('uses ORC_PROVIDER and ORC_MODEL when provider and model args are absent', async () => {
    const output = await runOrc([], {
      ORC_PROVIDER: 'trackable',
      ORC_MODEL: 'auto',
    });

    expect(output.provider).toBe('trackable');
    expect(output.modelAlias).toBe('auto');
    expect(output.modelID).toBe('auto');
    // bin/orc qualifies the model as provider/id so pi resolves the right provider.
    expect(output.piArgs).toEqual([
      '--model',
      'trackable/auto',
      '-e',
      resolve(repoRoot, 'src/pi-extensions/orchestrel-subagent-policy.ts'),
    ]);
  }, 30000);

  it('lets positional provider and model args override ORC_PROVIDER and ORC_MODEL', async () => {
    const output = await runOrc(['anthropic', 'opus'], {
      ORC_PROVIDER: 'trackable',
      ORC_MODEL: 'auto',
    });

    expect(output.provider).toBe('anthropic');
    expect(output.modelAlias).toBe('opus');
    expect(output.modelID).toBe('claude-opus');
    expect(output.passthroughArgs).toEqual([]);
  }, 30000);

  it('falls back to the selected provider first model when ORC_MODEL does not exist there', async () => {
    const output = await runOrc(['chatgpt'], {
      ORC_PROVIDER: 'trackable',
      ORC_MODEL: 'auto',
    });

    expect(output.provider).toBe('chatgpt');
    expect(output.modelAlias).toBe('gpt-5.5');
    expect(output.modelID).toBe('gpt-5.5');
    expect(output.passthroughArgs).toEqual([]);
  }, 30000);

  it('an explicit positional provider ignores ORC_MODEL and uses the provider first model', async () => {
    const output = await runOrc(['trackable'], {
      ORC_PROVIDER: 'chatgpt',
      ORC_MODEL: 'auto',
    });

    // bin/orc: an explicitly-specified provider ignores the global ORC_MODEL and
    // falls back to that provider's first model (see fix(orc) 638279b).
    expect(output.provider).toBe('trackable');
    expect(output.modelAlias).toBe('sonnet');
    expect(output.modelID).toBe('trackable-sonnet');
    expect(output.passthroughArgs).toEqual([]);
  }, 30000);

  it('prints ORC_PI_PATH in print-env output when overridden', async () => {
    const customPiPath = join(dir, 'custom-pi');

    const output = await runOrc([], {
      ORC_PI_PATH: customPiPath,
    });

    expect(output.piPath).toBe(customPiPath);
  }, 30000);

  it('strips legacy skip permissions flag from pi args', async () => {
    const output = await runOrc(['--dangerously-skip-permissions', 'trackable', 'auto'], {});

    expect(output.passthroughArgs).toEqual([]);
    // bin/orc qualifies the model as provider/id so pi resolves the right provider.
    expect(output.piArgs).toEqual([
      '--model',
      'trackable/auto',
      '-e',
      resolve(repoRoot, 'src/pi-extensions/orchestrel-subagent-policy.ts'),
    ]);
  }, 30000);

  it('passes the runtime subagent policy and extension to Pi without creating cwd .pi files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orc-clean-cwd-'));
    try {
      const stub = await runOrcSpawn(['trackable', 'auto'], cwd);

      expect(stub.args).toContain('-e');
      expect(stub.args).toContain(resolve(repoRoot, 'src/pi-extensions/orchestrel-subagent-policy.ts'));
      expect(JSON.parse(stub.env.ORCHESTREL_SUBAGENT_POLICY)).toMatchObject({
        parentProvider: 'trackable',
        parentModel: 'trackable/auto',
      });
      expect(existsSync(join(cwd, '.pi'))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30000);

  it('removes marked legacy overrides but preserves user-authored agent files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orc-legacy-cwd-'));
    const agentsDir = join(cwd, '.pi', 'agents');
    try {
      await mkdir(agentsDir, { recursive: true });
      await writeFile(join(agentsDir, 'marked.md'), '---\nmanaged_by: orchestrel\n---\n');
      await writeFile(join(agentsDir, 'unmarked.md'), '---\nmodel: user/model\n---\n');
      await runOrcSpawn(['trackable', 'auto'], cwd);

      expect(existsSync(join(agentsDir, 'marked.md'))).toBe(false);
      expect(existsSync(join(agentsDir, 'unmarked.md'))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30000);

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
          ORC_CONFIG: undefined,
          ORC_PROVIDER: undefined,
          ORC_MODEL: undefined,
          ORC_PI_PATH: env.ORC_PI_PATH ?? piPath,
          ...env,
        },
      },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  }

  async function runOrcSpawn(cliArgs: string[], cwd: string): Promise<{
    args: string[];
    env: { ORCHESTREL_SUBAGENT_POLICY: string };
  }> {
    await execFileAsync(tsxPath, [resolve(repoRoot, 'bin/orc'), '--config', configPath, ...cliArgs], {
      cwd,
      env: {
        ...process.env,
        ORC_CONFIG: undefined,
        ORC_PROVIDER: undefined,
        ORC_MODEL: undefined,
        ORC_PI_PATH: piPath,
        ORC_STUB_OUTPUT: stubOutputPath,
        PI_CODING_AGENT_DIR: join(dir, 'pi-agent'),
      },
    });
    return JSON.parse(await readFile(stubOutputPath, 'utf8')) as {
      args: string[];
      env: { ORCHESTREL_SUBAGENT_POLICY: string };
    };
  }
});
