import { resolve } from 'path';
import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { sessionManager } from '../agents/manager';
import { OpenCodeSession } from '../agents/opencode/session';
import type { AgentMessage, SessionStatus } from '../agents/types';
import type { FileRef } from '../../shared/ws-protocol';
import { copyOpencodeConfig, createWorktree, runSetupCommands, slugify, worktreeExists } from '../worktree';
import { wireSession } from '../controllers/oc';

export interface SessionStatusData {
  cardId: number;
  active: boolean;
  status: SessionStatus;
  sessionId: string | null;
  promptsSent: number;
  turnsCompleted: number;
  contextTokens: number;
  contextWindow: number;
}

async function ensureWorktree(card: Card): Promise<string> {
  console.log(
    `[session:${card.id}] ensureWorktree: worktreePath=${card.worktreePath}, useWorktree=${card.useWorktree}, projectId=${card.projectId}`,
  );

  // If worktreePath is set AND the directory still exists on disk, reuse it
  if (card.worktreePath && worktreeExists(card.worktreePath)) return card.worktreePath;

  // Stale worktreePath (directory gone) — clear it so we recreate below
  if (card.worktreePath && !worktreeExists(card.worktreePath)) {
    console.log(`[session:${card.id}] stale worktreePath ${card.worktreePath}, clearing`);
    card.worktreePath = null;
  }

  if (!card.projectId) throw new Error(`Card ${card.id} has no project`);
  const proj = await Project.findOneByOrFail({ id: card.projectId });

  if (!card.useWorktree) {
    card.worktreePath = proj.path;
    card.updatedAt = new Date().toISOString();
    await card.save();
    return proj.path;
  }

  const slug = card.worktreeBranch || slugify(card.title);
  const wtPath = `${proj.path}/.worktrees/${slug}`;
  const branch = slug;
  const source = card.sourceBranch ?? proj.defaultBranch ?? undefined;

  if (!worktreeExists(wtPath)) {
    console.log(`[session:${card.id}] worktree setup at ${wtPath}`);
    createWorktree(proj.path, wtPath, branch, source ?? undefined);
    if (proj.setupCommands) {
      console.log(`[session:${card.id}] running setup commands...`);
      runSetupCommands(wtPath, proj.setupCommands);
      console.log(`[session:${card.id}] setup commands done`);
    }
    copyOpencodeConfig(proj.path, wtPath);
  } else {
    console.log(`[session:${card.id}] worktree already exists at ${wtPath}`);
  }

  card.worktreePath = wtPath;
  card.worktreeBranch = branch;
  card.updatedAt = new Date().toISOString();
  await card.save();
  return wtPath;
}

class SessionService {
  async sendFollowUp(cardId: number, message: string, files?: FileRef[]): Promise<void> {
    const session = sessionManager.get(cardId);
    if (!session) throw new Error(`No active session for card ${cardId}`);
    if (session.status !== 'running' && session.status !== 'completed') {
      throw new Error(`Session for card ${cardId} is ${session.status}, cannot send follow-up`);
    }

    if (session instanceof OpenCodeSession) {
      const card = await Card.findOneByOrFail({ id: cardId });
      session.updateModel(card.model, card.thinkingLevel);
    }

    let prompt = message;
    if (files?.length) {
      for (const f of files) {
        if (!resolve(f.path).startsWith('/tmp/orchestrel-uploads/')) {
          throw new Error(`Invalid file path: ${f.path}`);
        }
      }
      const fileList = files.map((f) => `- ${f.path} (${f.name}, ${f.mimeType})`).join('\n');
      prompt = `I've attached the following files for you to review. Use the Read tool to read them:\n${fileList}\n\n${prompt}`;
    }

    await session.sendMessage(prompt);

    // Move back to running so the board reflects active work
    const card = await Card.findOneByOrFail({ id: cardId });
    card.promptsSent = session.promptsSent;
    if (card.column !== 'running') card.column = 'running';
    card.updatedAt = new Date().toISOString();
    await card.save();
  }

  async compactSession(cardId: number): Promise<void> {
    // If there's already an in-memory session, use it directly
    const existing = sessionManager.get(cardId);
    if (existing && existing instanceof OpenCodeSession) {
      await existing.compact();
      return;
    }

    // No in-memory session — create a temporary one so the SSE infrastructure
    // streams the summary back to the UI while OpenCode compacts.
    const card = await Card.findOneByOrFail({ id: cardId });
    if (!card.sessionId) throw new Error(`No session ID for card ${cardId}`);

    const cwd =
      card.worktreePath ?? (card.projectId ? (await Project.findOneByOrFail({ id: card.projectId })).path : null);
    if (!cwd) throw new Error(`No working directory for card ${cardId}`);

    let providerID = 'anthropic';
    let projectName: string | undefined;
    if (card.projectId) {
      const proj = await Project.findOneBy({ id: card.projectId });
      if (proj) {
        projectName = proj.name.toLowerCase();
        providerID = proj.providerID ?? 'anthropic';
      }
    }

    console.log(`[session:${cardId}] compact: creating temp session for SSE`);
    const session = sessionManager.create(cardId, {
      cwd,
      providerID,
      model: card.model ?? 'sonnet',
      thinkingLevel: (card.thinkingLevel ?? 'high') as 'off' | 'low' | 'medium' | 'high',
      resumeSessionId: card.sessionId,
      projectName,
    });
    session.promptsSent = card.promptsSent ?? 0;
    session.turnsCompleted = card.turnsCompleted ?? 0;

    wireSession(cardId, session);
    // attach() subscribes to SSE so we receive the streamed summary
    await session.attach();

    await session.compact();
    // SSE loop handles session.compacted event → emits compact_boundary
    // and session.idle → emits turn_end + sets status to completed
  }

  /**
   * Universal entry point for starting a session on a card.
   * Handles queueing for non-worktree cards — callers never need to
   * think about the queue. If the card must wait, its prompt is stashed
   * and processQueue will call launchSession when it's promoted.
   */
  async startSession(cardId: number, message?: string, files?: FileRef[]): Promise<void> {
    const existing = sessionManager.get(cardId);
    if (
      existing &&
      (existing.status === 'running' || existing.status === 'starting' || existing.status === 'completed')
    ) {
      console.log(`[session:${cardId}] session already ${existing.status}, forwarding as follow-up`);
      if (message) await this.sendFollowUp(cardId, message, files);
      return;
    }

    const card = await Card.findOneByOrFail({ id: cardId });
    if (!card.title?.trim()) throw new Error('Title is required for running');
    if (!card.description?.trim()) throw new Error('Description is required for running');

    // Stash the prompt so launchSession can pick it up later (or now)
    if (message || files?.length) {
      card.pendingPrompt = message ?? null;
      card.pendingFiles = files?.length ? JSON.stringify(files) : null;
      card.updatedAt = new Date().toISOString();
    }

    // Ensure card is in running — fires board:changed for UI
    if (card.column !== 'running') {
      card.column = 'running';
      card.updatedAt = new Date().toISOString();
      await card.save();
      // board:changed → registerAutoStart → processQueue handles the rest
      // for non-worktree cards. For worktree cards registerAutoStart calls
      // startSession again, which will fall through to launchSession below.
      if (!card.useWorktree && card.projectId) return;
    } else {
      // Already in running — save pending fields, then route
      if (message || files?.length) await card.save();
    }

    // Non-worktree: always go through the queue
    if (!card.useWorktree && card.projectId) {
      const { processQueue } = await import('./queue-gate');
      console.log(`[session:${cardId}] startSession: routing to processQueue (project=${card.projectId})`);
      await processQueue(card.projectId);
      return;
    }

    // Worktree or no project: launch directly
    await this.launchSession(card.id);
  }

  /**
   * Actually creates and starts the OpenCode session.
   * Only called by processQueue (for non-worktree) or startSession (for worktree).
   * Reads and clears pendingPrompt/pendingFiles from the card.
   */
  async launchSession(cardId: number): Promise<void> {
    const card = await Card.findOneByOrFail({ id: cardId });

    // Read and clear pending prompt/files
    const pendingMessage = card.pendingPrompt;
    const pendingFiles: FileRef[] | undefined = card.pendingFiles
      ? (JSON.parse(card.pendingFiles) as FileRef[])
      : undefined;

    if (card.pendingPrompt || card.pendingFiles) {
      card.pendingPrompt = null;
      card.pendingFiles = null;
      card.updatedAt = new Date().toISOString();
      await card.save();
    }

    // Build prompt
    let prompt = pendingMessage ?? card.description;
    if (!pendingMessage) {
      prompt = card.description;
    }
    if (pendingFiles?.length) {
      for (const f of pendingFiles) {
        if (!resolve(f.path).startsWith('/tmp/orchestrel-uploads/')) {
          throw new Error(`Invalid file path: ${f.path}`);
        }
      }
      const fileList = pendingFiles.map((f) => `- ${f.path} (${f.name}, ${f.mimeType})`).join('\n');
      prompt = `I've attached the following files for you to review. Use the Read tool to read them:\n${fileList}\n\n${prompt}`;
    }

    console.log(`[session:${cardId}] launchSession: calling ensureWorktree`);
    const cwd = await ensureWorktree(card);
    console.log(`[session:${cardId}] launchSession: worktree ready at ${cwd}`);

    let providerID = 'anthropic';
    let projectName: string | undefined;

    if (card.projectId) {
      const proj = await Project.findOneBy({ id: card.projectId });
      if (proj) {
        projectName = proj.name.toLowerCase();
        providerID = proj.providerID ?? 'anthropic';
      }
    }

    const isResume = !!card.sessionId;
    console.log(`[session:${cardId}] launchSession: creating session, provider=${providerID}, resume=${isResume}`);

    const session = sessionManager.create(cardId, {
      cwd,
      providerID,
      model: card.model ?? 'sonnet',
      thinkingLevel: (card.thinkingLevel ?? 'high') as 'off' | 'low' | 'medium' | 'high',
      resumeSessionId: card.sessionId ?? undefined,
      projectName,
    });

    if (isResume) {
      session.promptsSent = card.promptsSent ?? 0;
      session.turnsCompleted = card.turnsCompleted ?? 0;
    }

    wireSession(cardId, session);

    console.log(`[session:${cardId}] launchSession: calling session.start()`);
    await session.start(prompt);
    console.log(`[session:${cardId}] launchSession: start() done, calling waitForReady()`);
    await session.waitForReady();
    console.log(`[session:${cardId}] launchSession: session ready, sessionId=${session.sessionId}`);

    if (!isResume) {
      await card.reload();
      card.sessionId = session.sessionId;
      card.promptsSent = 1;
      card.turnsCompleted = 0;
      card.updatedAt = new Date().toISOString();
      await card.save();
    }
  }

  async attachSession(cardId: number): Promise<boolean> {
    // If we already have an active session tracked in the manager, nothing to do
    const existing = sessionManager.get(cardId);
    if (
      existing &&
      (existing.status === 'running' ||
        existing.status === 'starting' ||
        existing.status === 'completed' ||
        existing.status === 'retry')
    ) {
      return true;
    }

    const card = await Card.findOneByOrFail({ id: cardId });
    if (!card.sessionId) return false;

    const cwd =
      card.worktreePath ?? (card.projectId ? (await Project.findOneByOrFail({ id: card.projectId })).path : null);
    if (!cwd) return false;

    // Check if session is alive in OC
    const port = Number(process.env.OPENCODE_PORT ?? 4097);
    try {
      const res = await fetch(`http://localhost:${port}/session/status`, {
        headers: { 'x-opencode-directory': cwd },
      });
      if (!res.ok) return false;
      const statuses = (await res.json()) as Record<string, { type: string }>;
      if (statuses[card.sessionId]?.type !== 'busy') return false;
    } catch {
      return false;
    }

    console.log(`[session:${cardId}] attachSession: session ${card.sessionId} is busy, attaching`);

    let providerID = 'anthropic';
    let projectName: string | undefined;
    if (card.projectId) {
      const proj = await Project.findOneBy({ id: card.projectId });
      if (proj) {
        projectName = proj.name.toLowerCase();
        providerID = proj.providerID ?? 'anthropic';
      }
    }

    const session = sessionManager.create(cardId, {
      cwd,
      providerID,
      model: card.model ?? 'sonnet',
      thinkingLevel: (card.thinkingLevel ?? 'high') as 'off' | 'low' | 'medium' | 'high',
      resumeSessionId: card.sessionId,
      projectName,
    });

    session.promptsSent = card.promptsSent ?? 0;
    session.turnsCompleted = card.turnsCompleted ?? 0;

    wireSession(cardId, session);
    await session.attach();

    return true;
  }

  async sendMessage(cardId: number, message: string, files?: FileRef[]): Promise<void> {
    const existing = sessionManager.get(cardId);
    if (existing && (existing.status === 'running' || existing.status === 'completed')) {
      return this.sendFollowUp(cardId, message, files);
    }
    return this.startSession(cardId, message, files);
  }

  async stopSession(cardId: number): Promise<void> {
    const session = sessionManager.get(cardId);
    if (session) {
      // Graceful stop: keeps SSE alive, retries abort every 1s until idle
      sessionManager.requestStop(cardId);
    } else {
      // No in-memory session (e.g., post-restart) — fire-and-forget SDK abort
      const card = await Card.findOneBy({ id: cardId });
      if (card?.sessionId) {
        try {
          const { openCodeServer } = await import('../opencode/server');
          if (openCodeServer.client) {
            const cwd =
              card.worktreePath ??
              (card.projectId ? (await Project.findOneByOrFail({ id: card.projectId })).path : undefined);
            const sdk = openCodeServer.client as unknown as {
              session: { abort(opts: { sessionID: string; directory?: string }): Promise<void> };
            };
            await sdk.session.abort({ sessionID: card.sessionId, ...(cwd ? { directory: cwd } : {}) });
            console.log(`[session:${cardId}] SDK abort sent (no in-memory session) for ${card.sessionId}`);
          }
        } catch {
          // Already idle or session gone — harmless
        }
      }
    }
  }

  async getStatus(cardId: number): Promise<SessionStatusData | null> {
    const session = sessionManager.get(cardId);
    if (!session) return null;
    const card = await Card.findOneBy({ id: cardId });
    return {
      cardId,
      active: session.status === 'running' || session.status === 'starting' || session.status === 'retry',
      status: session.status,
      sessionId: session.sessionId,
      promptsSent: session.promptsSent,
      turnsCompleted: session.turnsCompleted,
      contextTokens: card?.contextTokens ?? 0,
      contextWindow: card?.contextWindow ?? 200_000,
    };
  }

  async getHistory(sessionId: string, _cardId: number): Promise<AgentMessage[]> {
    const { openCodeServer } = await import('../opencode/server');
    if (!openCodeServer.client) return [];

    interface SdkClient {
      session: {
        get(opts: { sessionID: string }): Promise<unknown>;
        messages(opts: { sessionID: string }): Promise<unknown>;
      };
    }
    const sdk = openCodeServer.client as unknown as SdkClient;

    const session = await sdk.session.get({ sessionID: sessionId });
    if (!session || (session as { success?: boolean }).success === false) return [];

    const rawMessages = await sdk.session.messages({ sessionID: sessionId });
    const rawMsgs = rawMessages as { success?: boolean; data?: unknown[] } | unknown[];
    const msgData =
      (rawMsgs as { success?: boolean }).success === false
        ? []
        : ((rawMsgs as { data?: unknown[] }).data ?? (Array.isArray(rawMsgs) ? rawMsgs : []));
    const msgList = (Array.isArray(msgData) ? msgData : []) as Record<string, unknown>[];

    const normalized: AgentMessage[] = [];
    for (const m of msgList) {
      normalized.push(...normalizeSessionMessage(m));
    }
    return normalized;
  }
}

function normalizeSessionMessage(msg: Record<string, unknown>): AgentMessage[] {
  const results: AgentMessage[] = [];
  const info = msg.info as { role?: string; time?: { created?: number } } | undefined;
  const role = info?.role ?? (msg.role as string);
  const parts = (msg.parts ?? []) as Array<Record<string, unknown>>;
  const infoTime = info?.time?.created;
  const msgTime = typeof msg.time === 'object' && msg.time ? (msg.time as { created?: number }).created : undefined;
  const ts = infoTime ?? msgTime ?? Date.now();

  for (const part of parts) {
    const partType = part.type as string;

    if (partType === 'text') {
      results.push({
        type: role === 'user' ? 'user' : 'text',
        role: role === 'user' ? 'user' : 'assistant',
        content: (part.text as string) ?? '',
        timestamp: ts,
      });
    }

    if (partType === 'reasoning') {
      results.push({
        type: 'thinking',
        role: 'assistant',
        content: (part.text as string) ?? '',
        timestamp: ts,
      });
    }

    if (partType === 'tool') {
      const state = part.state as
        | {
            status: string;
            input?: Record<string, unknown>;
            output?: string;
            error?: string;
            title?: string;
          }
        | undefined;
      if (state) {
        results.push({
          type: 'tool_call',
          role: 'assistant',
          content: state.title ?? '',
          toolCall: {
            id: (part.callID as string) ?? (part.id as string),
            name: (part.tool as string) ?? 'unknown',
            params: state.input,
          },
          timestamp: ts,
        });
        if (state.status === 'completed') {
          results.push({
            type: 'tool_result',
            role: 'assistant',
            content: state.output ?? '',
            toolResult: {
              id: (part.callID as string) ?? (part.id as string),
              output: state.output ?? '',
              isError: false,
            },
            timestamp: ts,
          });
        }
        if (state.status === 'error') {
          results.push({
            type: 'tool_result',
            role: 'assistant',
            content: state.error ?? 'Tool error',
            toolResult: {
              id: (part.callID as string) ?? (part.id as string),
              output: state.error ?? 'Tool error',
              isError: true,
            },
            timestamp: ts,
          });
        }
      }
    }
  }
  return results;
}

export const sessionService = new SessionService();
