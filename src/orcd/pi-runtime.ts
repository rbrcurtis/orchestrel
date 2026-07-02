/* oxlint-disable orchestrel/log-before-early-return -- pure SDK boundary wrapper returns mapped values/no-op fallbacks without session context */
import { AuthStorage, DEFAULT_COMPACTION_SETTINGS, ModelRegistry, SessionManager, createAgentSession, findCutPoint, generateSummary, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, AuthStorage as PiAuthStorage, CompactionResult, ProviderConfig as ProviderConfigInput } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelDef, ProviderType } from '../shared/config';

const EMPTY_API_KEY_ENV = 'ORCHESTREL_PI_EMPTY_API_KEY';

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
  /** Generate a BGC summary out-of-band (parallel-safe; does not mutate the session). null = nothing to compact. */
  prepareBgCompaction(keepFraction: number, currentTokens: number, signal: AbortSignal): Promise<CompactionResult | null>;
  /** Splice a prepared compaction into the session tree and rebuild context. Call only when idle. */
  applyBgCompaction(result: CompactionResult): void;
  /** True when the newest entry on the branch is already a compaction. */
  latestEntryIsCompaction(): boolean;
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
  const cfg: ProviderConfigInput = {
    name: provider.label ?? providerId,
    api,
    baseUrl: provider.baseUrl || 'https://api.anthropic.com',
    apiKey: provider.apiKey || provider.authToken || `$${EMPTY_API_KEY_ENV}`,
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

  // Bind extensions to emit the `session_start` event. Extensions that only
  // register providers/tools at load (e.g. claude-max) work without this, but
  // any extension that initializes on session_start (e.g. the MCP adapter that
  // connects to MCP servers) needs it. Pi's own headless print-mode binds here
  // too. Bindings are minimal — orcd has no TUI and drives sessions directly.
  await session.bindExtensions({
    onError: (err) => console.error(`[orcd] extension error (${err.extensionPath}): ${err.error}`),
  });

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

    async prepareBgCompaction(keepFraction, currentTokens, signal) {
      const sm = session.sessionManager as unknown as {
        getBranch(): Array<{ type: string; id: string; message?: unknown }>;
      };
      const entries = sm.getBranch();
      const keepRecentTokens = currentTokens > 0
        ? Math.floor(currentTokens * keepFraction)
        : DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
      const cut = findCutPoint(entries as never, 0, entries.length, keepRecentTokens);
      const firstKeptIdx = cut.firstKeptEntryIndex;
      if (firstKeptIdx <= 0) return null;
      const toSummarize = entries
        .slice(0, firstKeptIdx)
        .filter((e) => e.type === 'message' && e.message !== undefined)
        .map((e) => e.message);
      if (toSummarize.length === 0) return null;
      const auth = await modelRegistry.getApiKeyAndHeaders(model as Model<Api>);
      const apiKey = 'apiKey' in auth ? (auth as { apiKey?: string }).apiKey : undefined;
      const headers = 'headers' in auth ? (auth as { headers?: Record<string, string> }).headers : undefined;
      const agent = (session as unknown as { agent: { streamFn?: unknown } }).agent;
      const summary = await generateSummary(
        toSummarize as never,
        model as Model<Api>,
        DEFAULT_COMPACTION_SETTINGS.reserveTokens,
        apiKey,
        headers,
        signal,
        undefined,
        undefined,
        effortToThinkingLevel(opts.effort),
        agent.streamFn as never,
      );
      return { summary, firstKeptEntryId: entries[firstKeptIdx].id, tokensBefore: currentTokens, details: undefined };
    },

    applyBgCompaction(result) {
      const sm = session.sessionManager as unknown as {
        appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details: unknown, fromHook: boolean): string;
        buildSessionContext(): { messages: unknown[] };
      };
      sm.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, true);
      const agent = (session as unknown as { agent: { state: { messages: unknown[] } } }).agent;
      agent.state.messages = sm.buildSessionContext().messages;
    },

    latestEntryIsCompaction() {
      const sm = session.sessionManager as unknown as { getBranch(): Array<{ type?: string }> };
      const entries = sm.getBranch();
      const last = entries[entries.length - 1];
      return !!last && last.type === 'compaction';
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
