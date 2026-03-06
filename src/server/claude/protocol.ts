import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { SessionStatus } from './types';

const SESSIONS_DIR = join(process.cwd(), 'data', 'sessions');
mkdirSync(SESSIONS_DIR, { recursive: true });

export class ClaudeSession extends EventEmitter {
  process: ChildProcess | null = null;
  sessionId: string | null = null;
  status: SessionStatus = 'starting';
  messages: Record<string, unknown>[] = [];
  promptsSent = 0;
  turnsCompleted = 0;

  constructor(
    private cwd: string,
    private resumeSessionId?: string,
  ) {
    super();
  }

  async start(prompt: string): Promise<void> {
    await this.spawnWithPrompt(prompt, this.resumeSessionId);
  }

  private async spawnWithPrompt(prompt: string, resumeId?: string): Promise<void> {
    const args = [
      '-p',
      '--output-format=stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--max-turns', '1',
    ];

    if (resumeId) {
      args.push('--resume', resumeId);
    }

    // Prompt goes as CLI argument (not stdin) so Claude persists the session
    args.push(prompt);

    const env = { ...process.env };
    delete env.CLAUDECODE;

    this.process = spawn('/home/ryan/.local/bin/claude', args, {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    this.process.on('error', (err) => {
      this.status = 'errored';
      this.emit('exit', 1);
      console.error('Failed to spawn claude:', err.message);
    });

    const rl = createInterface({ input: this.process.stdout! });

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch {
        // non-JSON line, ignore
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      this.emit('stderr', data.toString());
    });

    this.process.on('exit', (code, signal) => {
      // SIGTERM from our auto-stop or stop button is a clean exit
      this.status = (code === 0 || signal === 'SIGTERM') ? 'completed' : 'errored';
      this.emit('exit', code);
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Capture session ID from any system message that has one
    if (msg.type === 'system' && typeof msg.session_id === 'string') {
      if (!this.sessionId) {
        this.sessionId = msg.session_id as string;
      }
      this.status = 'running';
    }

    // Don't emit control messages to client
    if (msg.type === 'control_request') return;

    // Buffer for late subscribers, persist, then emit
    this.messages.push(msg);
    this.persistMessage(msg);
    this.emit('message', msg);

    if (msg.type === 'result') {
      this.turnsCompleted++;
      // Don't kill — --max-turns 1 ensures Claude exits naturally,
      // which allows it to persist the session file for --resume
    }
  }

  async sendUserMessage(content: string): Promise<void> {
    this.promptsSent++;
    const msg = { type: 'user', message: { role: 'user', content } };
    // Buffer, persist, emit so subscribers see user prompts
    this.messages.push(msg);
    this.persistMessage(msg);
    this.emit('message', msg);

    // If no process or process completed, spawn a new one with --resume.
    if (!this.process || this.status === 'completed' || this.status === 'errored') {
      if (!this.sessionId) return;
      this.status = 'starting';
      await this.spawnWithPrompt(content, this.sessionId);
    }
    // If process is still running, auto-kill will fire when result arrives
    // and the next queued prompt will be handled by the router's message listener
  }

  private persistMessage(msg: Record<string, unknown>): void {
    if (!this.sessionId) return;
    try {
      appendFileSync(join(SESSIONS_DIR, `${this.sessionId}.jsonl`), JSON.stringify(msg) + '\n');
    } catch {
      // ignore write errors
    }
  }

  kill(): Promise<void> {
    if (!this.process) return Promise.resolve();
    return new Promise((resolve) => {
      this.process!.on('exit', () => resolve());
      this.process!.kill('SIGTERM');
    });
  }
}
