import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options as SDKOptions, Query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { AgentSession } from '../types';
import type { SessionStatus, AgentMessage } from '../types';
import { normalizeClaudeMessage } from './messages';

const MEMORY_MCP_BIN = '/home/ryan/Code/memory-mcp/dist/index.js';
const DEFAULT_QDRANT_URL = 'http://localhost:6333';

/** Read shared-memory MCP env from project .mcp.json, falling back to ~/.claude.json */
function getMemoryMcpEnv(cwd: string): Record<string, string> {
  // Try project-level .mcp.json first (mcpServers nested under root)
  try {
    const raw = readFileSync(join(cwd, '.mcp.json'), 'utf8');
    const cfg = JSON.parse(raw) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
    const env = cfg.mcpServers?.['shared-memory']?.env;
    if (env) return env;
  } catch { /* not found or invalid */ }

  // Fall back to user-level ~/.claude.json (mcpServers at root level)
  try {
    const raw = readFileSync(join(homedir(), '.claude.json'), 'utf8');
    const cfg = JSON.parse(raw) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
    return cfg.mcpServers?.['shared-memory']?.env ?? {};
  } catch {
    return {};
  }
}

export class ClaudeSession extends AgentSession {
  sessionId: string | null = null;
  status: SessionStatus = 'starting';
  promptsSent = 0;
  turnsCompleted = 0;

  private queryInstance: Query | null = null;
  private abortController: AbortController | null = null;
  private resumeSessionId: string | undefined;

  constructor(
    private cwd: string,
    resumeSessionId?: string,
    private projectName?: string,
    model: 'sonnet' | 'opus' = 'sonnet',
    thinkingLevel: 'off' | 'low' | 'medium' | 'high' = 'high',
  ) {
    super();
    this.resumeSessionId = resumeSessionId;
    this.model = model;
    this.thinkingLevel = thinkingLevel;

    // For resumed sessions, set sessionId immediately so waitForReady resolves
    if (resumeSessionId) {
      this.sessionId = resumeSessionId;
    }
  }

  async start(prompt: string): Promise<void> {
    console.log(`[session] start() called, cwd=${this.cwd}, prompt length=${prompt.length}`);
    // Emit normalized user message
    const msgs = normalizeClaudeMessage({ type: 'user', message: { role: 'user', content: prompt } });
    for (const m of msgs) this.emit('message', m);
    await this.runQuery(prompt, this.resumeSessionId);
  }

  private async runQuery(prompt: string, resumeId?: string): Promise<void> {
    this.abortController = new AbortController();

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const opts: SDKOptions = {
      cwd: this.cwd,
      env,
      abortController: this.abortController,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'user', 'local'],
      includePartialMessages: false,
      model: this.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
      thinking: this.thinkingLevel === 'off' ? { type: 'disabled' } : { type: 'adaptive' },
      effort: this.thinkingLevel === 'off' ? 'low' : this.thinkingLevel as 'low' | 'medium' | 'high',
    };

    if (resumeId) {
      opts.resume = resumeId;
    }

    if (this.projectName) {
      const mcpEnv = getMemoryMcpEnv(this.cwd);
      opts.mcpServers = {
        'shared-memory': {
          command: 'node',
          args: [MEMORY_MCP_BIN],
          env: {
            QDRANT_URL: mcpEnv.QDRANT_URL ?? DEFAULT_QDRANT_URL,
            ...(mcpEnv.QDRANT_API_KEY ? { QDRANT_API_KEY: mcpEnv.QDRANT_API_KEY } : {}),
            DEFAULT_AGENT: mcpEnv.DEFAULT_AGENT ?? 'claude-code',
            DEFAULT_PROJECT: this.projectName,
          },
        },
      };
    }

    this.queryInstance = query({ prompt, options: opts });

    // Run generator in background — don't await the full loop
    this.consumeMessages().catch((err) => {
      console.error('Query consumption error:', err);
      this.status = 'errored';
      this.emit('exit', 1);
    });
  }

  private async consumeMessages(): Promise<void> {
    if (!this.queryInstance) return;

    try {
      for await (const msg of this.queryInstance) {
        this.handleMessage(msg as Record<string, unknown>);
      }
      this.status = 'completed';
      console.log(`[session] completed normally, turns=${this.turnsCompleted}`);
      this.emit('exit', 0);
    } catch (err: unknown) {
      // AbortError means we called interrupt/abort — treat as clean exit
      if (err instanceof Error && err.name === 'AbortError') {
        this.status = 'completed';
        this.emit('exit', 0);
      } else {
        console.error('[session] SDK query error:', err);
        this.status = 'errored';
        this.emit('exit', 1);
      }
    } finally {
      this.queryInstance = null;
      this.abortController = null;
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Capture session ID from system init message (only for fresh sessions)
    if (msg.type === 'system' && typeof msg.session_id === 'string') {
      if (!this.sessionId && !this.resumeSessionId) {
        this.sessionId = msg.session_id;
      }
      this.status = 'running';
      console.log(`[session] status → running, sessionId=${this.sessionId ?? this.resumeSessionId}`);
    }

    const normalized = normalizeClaudeMessage(msg);
    for (const m of normalized) {
      this.emit('message', m);
    }

    if (msg.type === 'result') {
      this.turnsCompleted++;
    }
  }

  async sendMessage(content: string): Promise<void> {
    console.log(`[session] sendMessage, length=${content.length}, promptsSent=${this.promptsSent + 1}`);
    this.promptsSent++;
    // Set queryStartIndex BEFORE emitting so subscription replay includes this user message
    this.queryStartIndex = 0;
    const msgs = normalizeClaudeMessage({ type: 'user', message: { role: 'user', content } });
    for (const m of msgs) this.emit('message', m);

    // Interrupt running query if any, then resume with new prompt
    if (this.queryInstance) {
      try { await this.queryInstance.interrupt(); } catch { /* ignore */ }
    }
    const resumeId = this.sessionId ?? this.resumeSessionId;
    if (!resumeId) return;
    this.status = 'starting';
    await this.runQuery(content, resumeId);
  }

  async kill(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.queryInstance) {
      try { await this.queryInstance.interrupt(); } catch { /* ignore */ }
    }
  }

  waitForReady(): Promise<void> {
    // For resumed sessions, sessionId is already set — resolve immediately
    if (this.sessionId) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('message', onMessage);
        this.off('exit', onExit);
        reject(new Error('Timed out waiting for session init'));
      }, 30_000);

      const onMessage = (_msg: AgentMessage) => {
        if (this.sessionId) {
          clearTimeout(timeout);
          this.off('message', onMessage);
          this.off('exit', onExit);
          resolve();
        }
      };

      const onExit = () => {
        clearTimeout(timeout);
        this.off('message', onMessage);
        this.off('exit', onExit);
        reject(new Error('Session exited before init'));
      };

      this.on('message', onMessage);
      this.on('exit', onExit);
    });
  }
}
