/* oxlint-disable orchestrel/log-before-early-return -- pure SDK boundary wrapper returns mapped values/no-op fallbacks without session context */
import { AuthStorage, ModelRegistry, createAgentSession, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';

export interface CreatePiRuntimeSessionOpts {
  cwd: string;
  providerId: string;
  modelId: string;
  effort?: string;
}

export interface PiRuntimeSession {
  id: string;
  prompt(text: string, opts?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
  subscribe(cb: (event: unknown) => void): () => void;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<unknown>;
  setEffort(effort: string): Promise<void>;
  getMessages(): unknown[];
}

type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

function effortToThinkingLevel(effort: string | undefined): PiThinkingLevel {
  if (effort === 'disabled') return 'off';
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  if (effort === 'max') return 'xhigh';
  return 'high';
}

function canCompact(session: AgentSession): session is AgentSession & {
  compact(instructions?: string): Promise<unknown>;
} {
  return typeof session.compact === 'function';
}

function canSetThinkingLevel(session: AgentSession): session is AgentSession & {
  setThinkingLevel(level: PiThinkingLevel): void;
} {
  return typeof session.setThinkingLevel === 'function';
}

export async function createPiRuntimeSession(opts: CreatePiRuntimeSessionOpts): Promise<PiRuntimeSession> {
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create(`${agentDir}/auth.json`);
  const modelRegistry = ModelRegistry.create(authStorage, `${agentDir}/models.json`);
  const model = modelRegistry.find(opts.providerId, opts.modelId);
  if (!model) throw new Error(`Pi model not found: ${opts.providerId}/${opts.modelId}`);

  const result = await createAgentSession({
    cwd: opts.cwd,
    agentDir,
    authStorage,
    modelRegistry,
    model: model as Model<Api>,
    thinkingLevel: effortToThinkingLevel(opts.effort),
  });
  const session = result.session;

  return {
    id: session.sessionId,

    async prompt(text, promptOpts) {
      await session.prompt(text, promptOpts);
    },

    subscribe(cb) {
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => cb(event));
      return typeof unsubscribe === 'function' ? unsubscribe : () => undefined;
    },

    async abort() {
      await session.abort();
    },

    async compact(instructions) {
      if (!canCompact(session)) return undefined;
      return session.compact(instructions);
    },

    async setEffort(effort) {
      if (!canSetThinkingLevel(session)) return;
      session.setThinkingLevel(effortToThinkingLevel(effort));
    },

    getMessages() {
      const messages = session.messages;
      return Array.isArray(messages) ? [...messages] : [];
    },
  };
}
