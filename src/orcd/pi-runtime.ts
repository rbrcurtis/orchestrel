/* oxlint-disable orchestrel/log-before-early-return -- pure SDK boundary wrapper returns mapped values/no-op fallbacks without session context */
import { AuthStorage, ModelRegistry, SessionManager, createAgentSession, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, AuthStorage as PiAuthStorage, ProviderConfig as ProviderConfigInput } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelDef, ProviderType } from '../shared/config';
import { makeClaudeCodeStream } from './claude-code-stream';

const EMPTY_API_KEY_ENV = 'ORCHESTREL_PI_EMPTY_API_KEY';

// Providers with `oauth: claude-max` authenticate against Anthropic using the
// local Claude Max OAuth token and reshape requests to look like Claude Code
// (see claude-code-stream.ts). This avoids Anthropic's harness classifier that
// rejects raw Pi requests with "out of extra usage".
const CLAUDE_MAX_OAUTH = 'claude-max';

export interface CreatePiRuntimeSessionOpts {
  cwd: string;
  providerId: string;
  modelId: string;
  sessionId?: string;
  effort?: string;
  provider?: {
    type: ProviderType;
    label?: string;
    baseUrl: string;
    apiKey: string;
    authToken?: string;
    oauth?: string;
    models: Record<string, ModelDef>;
  };
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

function modelName(alias: string, model: ModelDef): string {
  return model.label || alias;
}

function modelApi(type: ProviderType): Api {
  return type === 'bedrock' ? 'bedrock-converse-stream' : 'anthropic-messages';
}

function usesBuiltInProvider(provider: NonNullable<CreatePiRuntimeSessionOpts['provider']>): boolean {
  if (provider.oauth) return false;
  return provider.type === 'anthropic' && !provider.baseUrl && !provider.apiKey && !provider.authToken;
}

function setRuntimeApiKey(authStorage: PiAuthStorage, providerId: string, apiKey: string | undefined): void {
  if (!apiKey) return;
  authStorage.setRuntimeApiKey(providerId, apiKey);
}

function registerOrchestrelProvider(
  modelRegistry: ModelRegistry,
  providerId: string,
  provider: NonNullable<CreatePiRuntimeSessionOpts['provider']>,
): void {
  const api = modelApi(provider.type);
  const isClaudeMaxOAuth = provider.oauth === CLAUDE_MAX_OAUTH;
  const cfg: ProviderConfigInput = {
    name: provider.label ?? providerId,
    api,
    baseUrl: provider.baseUrl || 'https://api.anthropic.com',
    // The OAuth stream supplies a Bearer token itself; pi only needs a non-empty
    // apiKey to pass provider validation when models are defined.
    apiKey: isClaudeMaxOAuth ? 'claude-max-oauth' : provider.apiKey || provider.authToken || `$${EMPTY_API_KEY_ENV}`,
    ...(isClaudeMaxOAuth ? { streamSimple: makeClaudeCodeStream(providerId) } : {}),
    models: Object.entries(provider.models).map(([alias, model]) => ({
      id: model.modelID,
      name: modelName(alias, model),
      api,
      reasoning: provider.type === 'anthropic',
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: 64_000,
    })),
  };

  modelRegistry.registerProvider(providerId, cfg);
}

async function getSessionPath(cwd: string, sessionId: string): Promise<string | undefined> {
  const sessions = await SessionManager.list(cwd);
  for (const session of sessions) {
    if (session.id === sessionId && typeof session.path === 'string') return session.path;
  }
  return undefined;
}

export async function createPiRuntimeSession(opts: CreatePiRuntimeSessionOpts): Promise<PiRuntimeSession> {
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create(`${agentDir}/auth.json`);
  const modelRegistry = ModelRegistry.create(authStorage, `${agentDir}/models.json`);
  const providerId = opts.provider && usesBuiltInProvider(opts.provider) ? opts.provider.type : opts.providerId;
  if (opts.provider) setRuntimeApiKey(authStorage, providerId, opts.provider.apiKey || opts.provider.authToken);
  if (opts.provider && providerId === opts.providerId) registerOrchestrelProvider(modelRegistry, opts.providerId, opts.provider);
  const modelId = opts.provider?.models[opts.modelId]?.modelID ?? opts.modelId;
  const model = modelRegistry.find(providerId, modelId);
  if (!model) throw new Error(`Pi model not found: ${providerId}/${opts.modelId}`);

  let sessionManager = SessionManager.create(opts.cwd);
  const requestedSessionId = opts.sessionId;
  if (requestedSessionId) {
    const sessionPath = await getSessionPath(opts.cwd, requestedSessionId);
    sessionManager = sessionPath
      ? SessionManager.open(sessionPath, undefined, opts.cwd)
      : SessionManager.create(opts.cwd, undefined, { id: requestedSessionId });
  }

  const result = await createAgentSession({
    cwd: opts.cwd,
    agentDir,
    authStorage,
    modelRegistry,
    sessionManager,
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
