import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupE2E, teardownE2E, getSocket, getProject, TEST_REPO_DIR } from './setup';
import {
  subscribe,
  emit,
  waitForCardInColumn,
  waitForAgentStatus,
  collectSessionMessages,
} from './helpers';
import type { Card, Project, AgentStatus } from '../src/shared/ws-protocol';

let project: Project;

// Cards created during tests -- tracked for cleanup
const cardIds: number[] = [];

beforeAll(async () => {
  const result = await setupE2E();
  project = result.project;
}, 30_000);

afterAll(async () => {
  // Delete test cards
  const socket = getSocket();
  for (const id of cardIds) {
    try {
      await emit(socket, 'card:delete', { id });
    } catch { /* may already be deleted */ }
  }
  await teardownE2E();
}, 30_000);

describe('Pi E2E Smoke Tests', () => {
  it('connects and subscribes to the board', async () => {
    const socket = getSocket();
    expect(socket.connected).toBe(true);

    const sync = await subscribe(socket);
    expect(sync.projects).toBeDefined();
    expect(sync.cards).toBeDefined();
    expect(sync.providers).toBeDefined();
    expect(sync.providers['anthropic']).toBeDefined();
  });

  it('creates a card on the Test project', async () => {
    const socket = getSocket();

    const card = await emit<Card>(socket, 'card:create', {
      title: 'Pi smoke test',
      description: 'Create a file called /tmp/pi-smoke-test.txt containing exactly "hello from pi". Do not create any other files.',
      projectId: project.id,
    });

    expect(card.id).toBeGreaterThan(0);
    expect(card.title).toBe('Pi smoke test');
    expect(card.projectId).toBe(project.id);
    expect(card.provider).toBe('anthropic');
    expect(card.model).toBe('sonnet');
    expect(card.thinkingLevel).toBe('off');
    // defaultWorktree=true, so a worktree branch should be assigned
    expect(card.worktreeBranch).toBeTruthy();

    cardIds.push(card.id);
  });
});
