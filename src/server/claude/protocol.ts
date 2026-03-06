import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import type { SessionStatus } from './types';

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

  async start(): Promise<void> {
    const args = [
      '--output-format=stream-json',
      '--input-format=stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    if (this.resumeSessionId) {
      args.unshift('--resume', this.resumeSessionId);
    } else {
      args.unshift('-p');
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;

    this.process = spawn('/home/ryan/.local/bin/claude', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
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

    // Send initialize control request
    this.send({
      type: 'control_request',
      request_id: `req_1_${Date.now().toString(16)}`,
      request: { subtype: 'initialize' },
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Capture session ID from any system message that has one
    if (msg.type === 'system' && typeof msg.session_id === 'string' && !this.sessionId) {
      this.sessionId = msg.session_id;
      this.status = 'running';
    }

    // Auto-approve tool use requests (since we use bypassPermissions,
    // this is a safety net -- shouldn't normally fire)
    if (msg.type === 'control_request') {
      const req = msg as { request_id: string; request: { subtype: string } };
      if (req.request.subtype === 'can_use_tool') {
        this.send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: req.request_id,
            response: { behavior: 'allow' },
          },
        });
      }
      return; // Don't emit control messages to client
    }

    // Buffer for late subscribers, then emit
    this.messages.push(msg);
    this.emit('message', msg);

    // Auto-stop when all queued prompts have been answered
    if (msg.type === 'result') {
      this.turnsCompleted++;
      if (this.turnsCompleted >= this.promptsSent) {
        this.kill();
      }
    }
  }

  sendUserMessage(content: string): void {
    this.promptsSent++;
    const msg = { type: 'user', message: { role: 'user', content } };
    // Buffer and emit so subscribers see user prompts
    this.messages.push(msg);
    this.emit('message', msg);
    this.send(msg);
  }

  private send(data: unknown): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(JSON.stringify(data) + '\n');
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
