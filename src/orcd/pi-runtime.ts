/* oxlint-disable orchestrel/log-before-early-return -- pure SDK boundary wrapper returns mapped values/no-op fallbacks without session context */
import { randomUUID } from 'node:crypto';
import { TranscriptSync } from './transcript-sync';
import type { ReplayDecision, TranscriptCursor, TranscriptEvent, TranscriptState } from '../shared/transcript-sync';
import {
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createEventBus,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  AgentSessionEvent,
  ProviderConfig as ProviderConfigInput,
} from '@earendil-works/pi-coding-agent';
import type { AnthropicMessagesCompat, Api, Model } from '@earendil-works/pi-ai';
import type { ModelDef, ProviderType } from '../shared/config';
import { buildSubagentPolicy, cleanupManagedSubagentFiles } from '../shared/subagent-policy';
import type { OrcdAuthor } from '../shared/orcd-protocol';
import { createOrchestrelSubagentPolicyExtension } from '../pi-extensions/orchestrel-subagent-policy';
import { expandInlineCommands } from './inline-commands';
import type { ProviderAliases } from '../shared/subagent-policy';

// Placeholder for providers without credentials (e.g. local oMLX endpoints).
// Pi's model registry requires an apiKey when models are defined, but the
// endpoint ignores it — so any non-empty value works.
const ANONYMOUS_API_KEY = 'anonymous';

type RuntimeProvider = {
  type: ProviderType;
  label?: string;
  baseUrl: string;
  apiKey: string;
  authToken?: string;
  oauth?: string;
  models: Record<string, ModelDef>;
  aliases?: ProviderAliases;
  agents?: Record<string, string>;
};

export interface CreatePiRuntimeSessionOpts {
  cwd: string;
  providerId: string;
  modelId: string;
  sessionId?: string;
  effort?: string;
  provider?: RuntimeProvider;
  /** All orcd providers, so a live setModel can register the target provider in this session's registry. */
  providers?: Record<string, RuntimeProvider>;
  /** Card threshold (0-1) mapped onto Pi's compaction reserve; 0 leaves compaction off. */
  summarizeThreshold?: number;
}

export interface PiRuntimeSession {
  id: string;
  prompt(text: string, opts?: { streamingBehavior?: 'steer' | 'followUp'; author?: OrcdAuthor }): Promise<void>;
  /** True while a Pi run is active, including a run started by a background-subagent notification. */
  isStreaming(): boolean;
  /** Resolve once Pi has no active run. */
  waitForIdle(): Promise<void>;
  subscribe(cb: (event: unknown) => void): () => void;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  /** Re-point Pi's compaction reserve at a new card threshold. */
  setSummarizeThreshold(threshold: number): void;
  /** Run Pi's own compaction now (foreground `/compact`); it aborts the current turn first. */
  compact(): Promise<void>;
  setEffort(effort: string): Promise<void>;
  /** Switch provider/model on the live Pi session (same conversation; Pi appends a model_change entry). */
  setModel(provider: string, model: string): Promise<void>;
  getMessages(): unknown[];
  getTranscriptSnapshot(): ReturnType<TranscriptSync['snapshot']>;
  /**
   * Answer a subscriber's cursor with the events it missed, or a snapshot when the
   * cursor is too old, from another stream, or ahead of this one.
   */
  replayTranscript(cursor: TranscriptCursor | undefined): ReplayDecision<TranscriptEvent, TranscriptState>;
}

type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

function effortToThinkingLevel(effort: string | undefined): PiThinkingLevel {
  if (effort === 'disabled') return 'off';
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  if (effort === 'max') return 'xhigh';
  // 'adaptive' also lands here: the session level becomes the effort hint sent
  // as output_config.effort; adaptive vs budget thinking is decided at provider
  // registration time (see registerOrchestrelProvider).
  return 'high';
}

/** True when the card's thinking level asks the endpoint to decide thinking depth itself. */
export function isAdaptiveEffort(effort: string | undefined): boolean {
  return effort === 'adaptive';
}

/**
 * Kept tail for a compaction. Pi's default is pinned here because the tail is the point of the
 * design: a fixed count cannot grow with the model's window, so a session moving from a 1M-token
 * model to a 240k one can never arrive with a tail that no longer fits.
 */
export const COMPACTION_KEEP_RECENT_TOKENS = 20_000;

/** Floor for the derived reserve, so a threshold near 1.0 still leaves the summarizer room. */
const MIN_COMPACTION_RESERVE_TOKENS = 8_192;

/**
 * Map a card's summarize threshold (0-1) onto Pi's compaction reserve. Pi compacts when
 * contextTokens > contextWindow - reserveTokens, so reserve = window * (1 - threshold) puts the
 * trigger exactly at window * threshold — the threshold keeps meaning the fraction of the window
 * a session may fill before it is compacted. Clamped so the reserve never reaches the window
 * (which would trigger at zero) and never falls below the floor.
 */
export function compactionReserveTokens(contextWindow: number, threshold: number): number {
  const floor = Math.min(MIN_COMPACTION_RESERVE_TOKENS, Math.floor(contextWindow / 2));
  const reserve = Math.floor(contextWindow * (1 - threshold));
  return Math.min(Math.max(reserve, floor), Math.max(contextWindow - floor, floor));
}

/** Point Pi's compaction at the session's threshold. Threshold 0 leaves compaction off. */
function applyCompactionSettings(
  settingsManager: SettingsManager,
  model: Model<Api>,
  summarizeThreshold: number,
): void {
  settingsManager.applyOverrides({
    compaction: {
      enabled: summarizeThreshold > 0,
      reserveTokens: compactionReserveTokens(model.contextWindow ?? 0, summarizeThreshold),
      keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
    },
  });
}

function canSetThinkingLevel(session: AgentSession): session is AgentSession & {
  setThinkingLevel(level: PiThinkingLevel): void;
} {
  return typeof session.setThinkingLevel === 'function';
}

function modelName(alias: string, model: ModelDef): string {
  return model.label || alias;
}

function modelForThinkingMode(model: Model<Api>, adaptive: boolean): Model<Api> {
  const current = model.compat as AnthropicMessagesCompat | undefined;
  if (!adaptive && current?.forceAdaptiveThinking !== true) return model;

  const compat: AnthropicMessagesCompat = { ...current };
  if (adaptive) compat.forceAdaptiveThinking = true;
  else delete compat.forceAdaptiveThinking;

  return {
    ...model,
    compat,
    ...(adaptive ? { thinkingLevelMap: { ...model.thinkingLevelMap, xhigh: 'xhigh' as const } } : {}),
  };
}

function modelApi(type: ProviderType): Api {
  if (type === 'bedrock') return 'bedrock-converse-stream';
  if (type === 'google') return 'google-generative-ai';
  return 'anthropic-messages';
}

function usesBuiltInProvider(provider: NonNullable<CreatePiRuntimeSessionOpts['provider']>): boolean {
  if (provider.oauth) return false;
  return provider.type === 'anthropic' && !provider.baseUrl && !provider.apiKey && !provider.authToken;
}

async function setRuntimeApiKey(
  modelRuntime: ModelRuntime,
  providerId: string,
  apiKey: string | undefined,
): Promise<void> {
  if (!apiKey) return;
  await modelRuntime.setRuntimeApiKey(providerId, apiKey);
}

function registerOrchestrelProvider(
  modelRegistry: ModelRegistry,
  providerId: string,
  provider: NonNullable<CreatePiRuntimeSessionOpts['provider']>,
  adaptive: boolean,
): void {
  const api = modelApi(provider.type);
  const cfg: ProviderConfigInput = {
    name: provider.label ?? providerId,
    api,
    baseUrl: provider.baseUrl || 'https://api.anthropic.com',
    apiKey: provider.apiKey || provider.authToken || ANONYMOUS_API_KEY,
    models: Object.entries(provider.models).map(([alias, model]) => ({
      id: model.modelID,
      name: modelName(alias, model),
      api,
      reasoning: provider.type !== 'bedrock',
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: 64_000,
      // Send the pi session id upstream so prompt caches key on the session
      // instead of a fresh id per request. The Kiro proxy reads it.
      // Adaptive thinking (card thinking level = adaptive): let the endpoint
      // decide how much to think instead of capping it with a fixed budget, and
      // advertise xhigh so 'max' effort isn't clamped back to 'high'.
      compat: {
        sendSessionAffinityHeaders: true,
        ...(adaptive ? { forceAdaptiveThinking: true } : {}),
      },
      ...(adaptive ? { thinkingLevelMap: { xhigh: 'xhigh' } } : {}),
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
  const modelRuntime = await ModelRuntime.create({
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const providerId = opts.provider && usesBuiltInProvider(opts.provider) ? opts.provider.type : opts.providerId;
  if (opts.provider) await setRuntimeApiKey(modelRuntime, providerId, opts.provider.apiKey || opts.provider.authToken);
  if (opts.provider && providerId === opts.providerId) {
    registerOrchestrelProvider(modelRegistry, opts.providerId, opts.provider, isAdaptiveEffort(opts.effort));
  }
  const registered = new Set<string>();
  if (opts.provider && providerId === opts.providerId) registered.add(opts.providerId);
  let currentEffort = opts.effort;
  let adaptive = isAdaptiveEffort(currentEffort);
  // Live model switches may target another provider in orcd.yaml. Pi's model
  // registry and auth store are per-session, so register + key the target
  // provider on first use (mirrors the initial registration above).
  async function ensureProvider(pId: string, cfg: RuntimeProvider): Promise<void> {
    if (registered.has(pId)) return;
    await setRuntimeApiKey(modelRuntime, pId, cfg.apiKey || cfg.authToken);
    registerOrchestrelProvider(modelRegistry, pId, cfg, adaptive);
    registered.add(pId);
  }
  const modelId = opts.provider?.models[opts.modelId]?.modelID ?? opts.modelId;
  const foundModel = modelRegistry.find(providerId, modelId);
  if (!foundModel) throw new Error(`Pi model not found: ${providerId}/${opts.modelId}`);
  let baseModel = modelForThinkingMode(foundModel as Model<Api>, false);
  let activeModel = modelForThinkingMode(baseModel, adaptive);

  // Legacy managed files were process-global configuration. Remove them before
  // discovery; the policy extension below is isolated to this session's loader.
  cleanupManagedSubagentFiles(opts.cwd);
  const policy = buildSubagentPolicy(
    providerId,
    modelId,
    opts.provider ?? {
      models: { [opts.modelId]: { label: opts.modelId, modelID: modelId, contextWindow: 200_000 } },
    },
  );
  const eventBus = createEventBus();
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir,
    eventBus,
    extensionFactories: [
      createOrchestrelSubagentPolicyExtension(policy, {
        onDecision: ({ agentType, decision }) => {
          if ('model' in decision)
            console.log(`[orcd] subagent ${agentType} -> ${decision.model} (${decision.source})`);
        },
      }),
    ],
  });
  await resourceLoader.reload();

  let sessionManager = SessionManager.create(opts.cwd);
  const requestedSessionId = opts.sessionId;
  if (requestedSessionId) {
    const sessionPath = await getSessionPath(opts.cwd, requestedSessionId);
    sessionManager = sessionPath
      ? SessionManager.open(sessionPath, undefined, opts.cwd)
      : SessionManager.create(opts.cwd, undefined, { id: requestedSessionId });
  }

  // Pi owns compaction: the card's threshold becomes its reserve, so it compacts at
  // window * threshold and keeps COMPACTION_KEEP_RECENT_TOKENS verbatim. Both of Pi's
  // triggers (post-run and pre-prompt) act between turns, never mid-turn.
  let summarizeThreshold = opts.summarizeThreshold ?? 0;
  const settingsManager = SettingsManager.create(opts.cwd, agentDir);
  applyCompactionSettings(settingsManager, activeModel, summarizeThreshold);

  const result = await createAgentSession({
    cwd: opts.cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
    model: activeModel,
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

  const transcript = new TranscriptSync(randomUUID(), session.sessionManager.getEntries(), 512, 1_048_576);
  const transcriptListeners = new Set<(event: unknown) => void>();
  const stopTranscript = session.subscribe((event) => {
    if (event.type === 'agent_settled' || event.type === 'compaction_end') {
      const envelope = transcript.settle(session.sessionManager.getEntries());
      for (const listener of transcriptListeners) listener({ type: 'transcript_event', envelope });
    } else {
      const envelope = transcript.accept(event);
      for (const listener of transcriptListeners) listener({ type: 'transcript_event', envelope });
      if (event.type === 'message_end') transcript.boundLiveState();
    }
  });

  return {
    id: session.sessionId,
    getTranscriptSnapshot() {
      return transcript.snapshot();
    },

    replayTranscript(cursor) {
      return transcript.replaySince(cursor);
    },

    async prompt(text, promptOpts) {
      // Author annotation: write a non-context custom entry as the current leaf
      // so the session JSONL records who sent this turn before the user message
      // (Pi appends the user message as a child of the leaf). Custom entries do
      // not enter LLM context, so this annotates without polluting the prompt.
      // Kept here, immediately before session.prompt, so every prompt path
      // (fresh turn, followUp, mid-session message) is covered.
      if (promptOpts?.author) {
        try {
          session.sessionManager.appendCustomEntry('orc.author', promptOpts.author);
        } catch (err) {
          console.warn(`[orcd] author annotation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // expandInlineCommands keeps `text` verbatim and appends the expansion
      // after a marker. Disable Pi's own expansion so a leading /command is not
      // expanded a second time.
      const expanded = expandInlineCommands(session, text);
      await session.prompt(expanded, { ...promptOpts, expandPromptTemplates: false });
    },

    isStreaming() {
      return session.isStreaming;
    },

    async waitForIdle() {
      await session.waitForIdle();
    },

    subscribe(cb) {
      transcriptListeners.add(cb);
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => cb(event));
      return () => {
        transcriptListeners.delete(cb);
        unsubscribe();
      };
    },

    async abort() {
      await session.abort();
    },

    async dispose() {
      try {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      } finally {
        stopTranscript();
        transcriptListeners.clear();
        transcript.dispose();
        session.dispose();
      }
    },

    setSummarizeThreshold(threshold) {
      summarizeThreshold = threshold;
      applyCompactionSettings(settingsManager, activeModel, threshold);
      const reserve = compactionReserveTokens(activeModel.contextWindow ?? 0, threshold);
      console.log(`[orcd] compaction threshold → ${threshold} (reserve=${reserve})`);
    },

    async compact() {
      await session.compact();
    },

    async setEffort(effort) {
      if (!canSetThinkingLevel(session)) return;
      const nextAdaptive = isAdaptiveEffort(effort);
      if (nextAdaptive !== adaptive) {
        const next = modelForThinkingMode(baseModel, nextAdaptive);
        await session.setModel(next);
        activeModel = next;
        adaptive = nextAdaptive;
      }
      session.setThinkingLevel(effortToThinkingLevel(effort));
      currentEffort = effort;
    },

    async setModel(provider, model) {
      const cfg = opts.providers?.[provider];
      if (!cfg) throw new Error(`setModel: provider not in orcd config: ${provider}`);
      // Live switching needs an explicit anthropic-compatible endpoint with its
      // own credentials. Built-in/OAuth providers (e.g. claude-max) authenticate
      // through extensions registered at session start and cannot be re-keyed
      // here — such a switch must start a fresh session instead.
      const live = cfg.type === 'anthropic' && !cfg.oauth && !!(cfg.baseUrl || cfg.apiKey || cfg.authToken);
      if (!live) {
        throw new Error(
          `setModel: provider ${provider} does not support live switching (needs an anthropic-compatible baseUrl/apiKey and no oauth)`,
        );
      }
      await ensureProvider(provider, cfg);
      const targetModelId = cfg.models[model]?.modelID ?? model;
      const next = modelRegistry.find(provider, targetModelId);
      if (!next) throw new Error(`setModel: model not found: ${provider}/${model}`);
      const agentSession = session as unknown as { setModel(m: Model<Api>): Promise<void> };
      if (typeof agentSession.setModel !== 'function') {
        throw new Error('setModel: Pi runtime does not support live model switching');
      }
      baseModel = modelForThinkingMode(next as Model<Api>, false);
      activeModel = modelForThinkingMode(baseModel, adaptive);
      await agentSession.setModel(activeModel);
      // The reserve is a fraction of the window, so a switch to a model with a different
      // window must re-derive it or the trigger point silently moves with the old one.
      applyCompactionSettings(settingsManager, activeModel, summarizeThreshold);
      console.log(`[orcd] session model → ${provider}/${model}`);
    },

    getMessages() {
      const messages = session.messages;
      return Array.isArray(messages) ? [...messages] : [];
    },
  };
}
