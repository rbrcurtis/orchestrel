import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options as SDKOptions, Query } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SessionStatus } from './types';

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

const SESSIONS_DIR = join(process.cwd(), 'data', 'sessions');
mkdirSync(SESSIONS_DIR, { recursive: true });

export class ClaudeSession extends EventEmitter {
  sessionId: string | null = null;
  status: SessionStatus = 'starting';
  messages: Record<string, unknown>[] = [];
  promptsSent = 0;
  turnsCompleted = 0;

  private queryInstance: Query | null = null;
  private abortController: AbortController | null = null;
  queryStartIndex = 0;

  constructor(
    private cwd: string,
    private resumeSessionId?: string,
    private projectName?: string,
  ) {
    super();
  }

  async start(prompt: string): Promise<void> {
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
      this.emit('exit', 0);
    } catch (err: unknown) {
      // AbortError means we called interrupt/abort — treat as clean exit
      if (err instanceof Error && err.name === 'AbortError') {
        this.status = 'completed';
        this.emit('exit', 0);
      } else {
        console.error('[ClaudeSession] SDK query error:', err);
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
    }

    // Buffer, persist, emit
    this.messages.push(msg);
    this.persistMessage(msg);
    this.emit('message', msg);

    if (msg.type === 'result') {
      this.turnsCompleted++;
    }
  }

  async sendUserMessage(content: string): Promise<void> {
    this.promptsSent++;
    const msg = { type: 'user', message: { role: 'user', content } };
    this.messages.push(msg);
    this.persistMessage(msg);
    this.emit('message', msg);

    // Interrupt running query if any, then resume with new prompt
    if (this.queryInstance) {
      try { await this.queryInstance.interrupt(); } catch { /* ignore */ }
    }
    const resumeId = this.sessionId ?? this.resumeSessionId;
    if (!resumeId) return;
    this.queryStartIndex = this.messages.length;
    this.status = 'starting';
    await this.runQuery(content, resumeId);
  }

  private persistMessage(msg: Record<string, unknown>): void {
    const sid = this.sessionId ?? this.resumeSessionId;
    if (!sid) return;
    try {
      appendFileSync(
        join(SESSIONS_DIR, `${sid}.jsonl`),
        JSON.stringify(msg) + '\n',
      );
    } catch { /* ignore */ }
  }

  async kill(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.queryInstance) {
      try { await this.queryInstance.interrupt(); } catch { /* ignore */ }
    }
  }
}
