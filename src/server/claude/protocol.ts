import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import type { SessionStatus } from './types';

export class ClaudeSession extends EventEmitter {
  process: ChildProcess | null = null;
  sessionId: string | null = null;
  status: SessionStatus = 'starting';

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
      '--permission-mode=bypassPermissions',
    ];

    if (this.resumeSessionId) {
      args.unshift('--resume', this.resumeSessionId);
    } else {
      args.unshift('-p');
    }

    this.process = spawn('claude', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
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

    this.process.on('exit', (code) => {
      this.status = code === 0 ? 'completed' : 'errored';
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
    // Capture session ID from init message
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.sessionId = msg.session_id as string;
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

    // Track completion
    if (msg.type === 'result') {
      this.status = 'completed';
    }

    // Emit all other messages to listeners
    this.emit('message', msg);
  }

  sendUserMessage(content: string): void {
    this.send({
      type: 'user',
      message: { role: 'user', content },
    });
  }

  private send(data: unknown): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(JSON.stringify(data) + '\n');
    }
  }

  kill(): void {
    this.process?.kill('SIGTERM');
    this.status = 'errored';
  }
}
