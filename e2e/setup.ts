import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { connect, subscribe, emit } from './helpers';
import type { AppSocket } from './helpers';
import type { Project, SyncPayload } from '../src/shared/ws-protocol';

export const TEST_REPO_DIR = join(tmpdir(), 'orchestrel-e2e-test-repo');

let socket: AppSocket;
let testProject: Project;

/** Create a bare-minimum git repo for testing. */
function createTestRepo(): void {
  if (existsSync(TEST_REPO_DIR)) rmSync(TEST_REPO_DIR, { recursive: true });
  mkdirSync(TEST_REPO_DIR, { recursive: true });
  execFileSync('git', ['init'], { cwd: TEST_REPO_DIR, stdio: 'pipe' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: TEST_REPO_DIR, stdio: 'pipe' });
  writeFileSync(join(TEST_REPO_DIR, 'README.md'), '# E2E Test Repo\n');
  execFileSync('git', ['add', '.'], { cwd: TEST_REPO_DIR, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'add readme'], { cwd: TEST_REPO_DIR, stdio: 'pipe' });
}

/** Remove the temp repo and any worktrees it created. */
function cleanupTestRepo(): void {
  if (existsSync(TEST_REPO_DIR)) {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: TEST_REPO_DIR, stdio: 'pipe' });
    } catch { /* ignore */ }
    const wtDir = join(TEST_REPO_DIR, '.worktrees');
    if (existsSync(wtDir)) rmSync(wtDir, { recursive: true, force: true });
    rmSync(TEST_REPO_DIR, { recursive: true, force: true });
  }
}

export async function setupE2E(): Promise<{
  socket: AppSocket;
  project: Project;
  sync: SyncPayload;
}> {
  // 1. Create temp git repo
  createTestRepo();

  // 2. Connect to orchestrel-pi
  socket = await connect();

  // 3. Subscribe to get current state
  const sync = await subscribe(socket);

  // 4. Create "Test" project via Socket.IO
  testProject = await emit<Project>(socket, 'project:create', {
    name: 'Test',
    path: TEST_REPO_DIR,
    defaultModel: 'sonnet',
    defaultThinkingLevel: 'off',
    providerID: 'anthropic',
    defaultWorktree: true,
    defaultBranch: 'main',
  });

  console.log(`[e2e] Test project created: id=${testProject.id}, path=${TEST_REPO_DIR}`);

  return { socket, project: testProject, sync };
}

export async function teardownE2E(): Promise<void> {
  // Delete test project from DB
  if (socket?.connected && testProject) {
    try {
      await emit(socket, 'project:delete', { id: testProject.id });
      console.log(`[e2e] Test project deleted: id=${testProject.id}`);
    } catch (err) {
      console.warn(`[e2e] project delete failed:`, err);
    }
  }

  // Disconnect socket
  socket?.disconnect();

  // Clean up temp repo
  cleanupTestRepo();
}

export function getSocket(): AppSocket {
  return socket;
}

export function getProject(): Project {
  return testProject;
}
