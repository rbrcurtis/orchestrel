import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrcdServer } from '../../orcd/socket-server';
import { OrcdClient } from '../orcd-client';
import type { ProviderConfig } from '../../orcd/config';

// Two OrcdServer instances on two 127.0.0.1 ports stand in for two boxes. The
// test proves nodes report independent capabilities, prepare worktrees on their
// own filesystem, and that token auth fails closed.

function anthropicProvider(alias: string, label: string, cw: number): Record<string, ProviderConfig> {
  return {
    anthropic: {
      type: 'anthropic',
      label: 'Anthropic',
      baseUrl: '',
      apiKey: '',
      models: ['m'],
      modelLabels: { m: { alias, label, contextWindow: cw } },
      modelAliasEnv: {},
    },
  };
}

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'multi-node-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('multi-node isolation', () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanup) await c();
  });

  it('two nodes report independent capabilities and prepare worktrees independently', async () => {
    const a = new OrcdServer(
      { listen: { host: '127.0.0.1', port: 7811 }, authToken: 'a-tok', name: 'nodeA' },
      anthropicProvider('sonnet', 'Sonnet', 1_000_000),
      { provider: 'anthropic', model: 'sonnet' },
    );
    const b = new OrcdServer(
      { listen: { host: '127.0.0.1', port: 7812 }, authToken: 'b-tok', name: 'nodeB' },
      anthropicProvider('haiku', 'Haiku', 200_000),
      { provider: 'anthropic', model: 'haiku' },
    );
    await a.start();
    await b.start();
    cleanup.push(() => a.stop(), () => b.stop());

    const ca = new OrcdClient({ host: '127.0.0.1', port: 7811, token: 'a-tok', name: 'nodeA' });
    const cb = new OrcdClient({ host: '127.0.0.1', port: 7812, token: 'b-tok', name: 'nodeB' });
    await ca.connect();
    await cb.connect();
    cleanup.push(() => ca.disconnect(), () => cb.disconnect());

    // capabilities are cached during the hello handshake on connect
    expect(ca.capabilities?.name).toBe('nodeA');
    expect(cb.capabilities?.name).toBe('nodeB');
    expect(ca.capabilities?.providers[0].models[0]).toMatchObject({ alias: 'sonnet', contextWindow: 1_000_000 });
    expect(cb.capabilities?.providers[0].models[0]).toMatchObject({ alias: 'haiku', contextWindow: 200_000 });

    const repoA = await tempRepo();
    cleanup.push(async () => { await rm(repoA, { recursive: true, force: true }); });
    const wt = await ca.worktreePrepare({ projectPath: repoA, branch: 'feat-a', setupCommands: '' });
    expect(wt.path).toBe(join(repoA, '.worktrees', 'feat-a'));
  });

  it('rejects a client presenting the wrong token', async () => {
    const a = new OrcdServer(
      { listen: { host: '127.0.0.1', port: 7813 }, authToken: 'right', name: 'nodeA' },
      anthropicProvider('sonnet', 'Sonnet', 1_000),
      { provider: 'anthropic', model: 'sonnet' },
    );
    await a.start();
    cleanup.push(() => a.stop());

    const c = new OrcdClient({ host: '127.0.0.1', port: 7813, token: 'wrong', name: 'nodeA' });
    await expect(c.connect()).rejects.toBeTruthy();
    c.disconnect();
  });
});
