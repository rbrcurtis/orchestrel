/* oxlint-disable orchestrel/log-before-early-return -- pure SDK boundary wrapper returns mapped values/no-op fallbacks without session context */
import { randomUUID } from 'node:crypto';
import { TranscriptSync } from './transcript-sync';
import type { ReplayDecision, TranscriptCursor, TranscriptEvent, TranscriptState } from '../shared/transcript-sync';
import {
  DEFAULT_COMPACTION_SETTINGS,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createEventBus,
  findCutPoint,
  generateSummary,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  AgentSessionEvent,
  CompactionResult,
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
  /**
   * Generate a BGC summary out-of-band (parallel-safe; does not mutate the session).
   * `currentTokens` is the pre-compaction size the caller measured; it is recorded on the
   * result as tokensBefore. null = nothing to compact.
   */
  prepareBgCompaction(
    currentTokens: number,
    signal: AbortSignal,
    onStart?: () => void,
  ): Promise<CompactionResult | null>;
  /**
   * Splice a prepared compaction into the session tree and rebuild context. Call
   * only when idle. False = the prepared cut is stale (a newer compaction already
   * moved the boundary past it) and nothing was spliced.
   */
  applyBgCompaction(result: CompactionResult): boolean;
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
 * One entry of Pi's session branch. Compaction entries carry the boundary the live
 * context starts at; message entries are the only ones a summary can be built from.
 */
type BranchEntry = {
  type: string;
  id: string;
  message?: unknown;
  summary?: string;
  firstKeptEntryId?: string;
};

/**
 * Locate the live context's start: the newest compaction's kept entry. Everything
 * before it is already summarized, so summarizing it again overflows the model's
 * window (a 1M-token model gets ~3M tokens after a handful of compactions) and the
 * splice never lands. Pi's own prepareCompaction starts at the same boundary.
 */
function compactionBoundary(entries: BranchEntry[]): { index: number; previousSummary: string | undefined } {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== 'compaction') continue;
    const keptIdx = entries.findIndex((e) => e.id === entries[i].firstKeptEntryId);
    return { index: keptIdx >= 0 ? keptIdx : i + 1, previousSummary: entries[i].summary };
  }
  return { index: 0, previousSummary: undefined };
}

/**
 * Reserve for a summarization call. Pi caps the response at
 * min(floor(0.8 * reserveTokens), model.maxTokens) and refuses a summary that hits that cap
 * (a partial summary must not become a checkpoint). Pi's default reserve caps it at 13,107
 * tokens, which a long session outgrows — once the iterative summary passes the cap every
 * future compaction fails, so scale the reserve to the model's own output limit instead.
 */
function summaryReserveTokens(model: { maxTokens: number }): number {
  return model.maxTokens > 0 ? Math.ceil(model.maxTokens / 0.8) : DEFAULT_COMPACTION_SETTINGS.reserveTokens;
}

/**
 * Tail kept after a BGC splice, in tokens. Fixed at the same 20,000 Pi's own compactor
 * keeps, deliberately NOT a fraction of the live context: a fraction grows with the
 * session, so what survives a compaction tracks whatever the session happens to be
 * (30% of a 240k-token session is 72k live tokens, three and a half times this), and a
 * session that moves to a smaller window can arrive with a tail that no longer fits.
 */
const BGC_KEEP_RECENT_TOKENS = 20_000;

/**
 * Ceiling asked of the summarizer, in tokens. Each pass merges the previous summary and adds
 * new history, so the summary grows monotonically unless it is held down; pi's own prompt only
 * says "keep each section concise", which let one session's summaries climb from 10k to 72k
 * characters before they stopped fitting the output cap. 8,000 tokens leaves roughly an order
 * of magnitude of headroom under a 64,000-token cap, and only the summarized span (not the
 * kept tail) is compressed to that size.
 */
const BGC_SUMMARY_TOKEN_BUDGET = 8000;
const BGC_SUMMARY_INSTRUCTIONS =
  `Keep the entire summary under ${BGC_SUMMARY_TOKEN_BUDGET} tokens. Collapse older items to one terse line ` +
  'each, and drop detail that the code, the file paths or the git history already record. Never re-explain ' +
  'something a previous section already states; compress the oldest material hardest.';

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

  // orcd owns compaction (see maybeStartBgc). Pi's threshold and overflow
  // compactor would race the background compactor and can splice a cut the other
  // has already superseded, so turn it off and leave BGC as the only compactor.
  const settingsManager = SettingsManager.create(opts.cwd, agentDir);
  settingsManager.applyOverrides({ compaction: { enabled: false } });

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

    async prepareBgCompaction(currentTokens, signal, onStart) {
      const sm = session.sessionManager as unknown as { getBranch(): BranchEntry[] };
      const entries = sm.getBranch();
      const boundary = compactionBoundary(entries);
      const boundaryStart = boundary.index;
      const previousSummary = boundary.previousSummary;
      const cut = findCutPoint(entries as never, boundaryStart, entries.length, BGC_KEEP_RECENT_TOKENS);
      const firstKeptIdx = cut.firstKeptEntryIndex;
      if (firstKeptIdx <= boundaryStart) return null;
      const toSummarize = entries
        .slice(boundaryStart, firstKeptIdx)
        .filter((e) => e.type === 'message' && e.message !== undefined)
        .map((e) => e.message);
      if (toSummarize.length === 0) return null;
      // A compactable range exists. Only now is a UI "started" marker truthful —
      // a null return means nothing to compact and must not be announced.
      onStart?.();
      const auth = await modelRegistry.getApiKeyAndHeaders(activeModel);
      const apiKey = 'apiKey' in auth ? (auth as { apiKey?: string }).apiKey : undefined;
      const headers = 'headers' in auth ? (auth as { headers?: Record<string, string> }).headers : undefined;
      const agent = (session as unknown as { agent: { streamFn?: unknown } }).agent;
      const summary = await generateSummary(
        toSummarize as never,
        activeModel,
        summaryReserveTokens(activeModel),
        apiKey,
        headers,
        signal,
        // Bound the summary: without a budget it grows with the session until it no longer
        // fits the output cap, and then every compaction fails (see BGC_SUMMARY_TOKEN_BUDGET).
        BGC_SUMMARY_INSTRUCTIONS,
        // Merge the previous summary so a BGC never drops the history it already compacted.
        previousSummary,
        // Summarizing is mechanical restatement of history, so thinking only delays
        // the splice and eats output budget. BGC never thinks, whatever the session's
        // thinking level is (a background job must not inherit a per-turn setting).
        'off',
        agent.streamFn as never,
      );
      return { summary, firstKeptEntryId: entries[firstKeptIdx].id, tokensBefore: currentTokens, details: undefined };
    },

    applyBgCompaction(result) {
      const sm = session.sessionManager as unknown as {
        getBranch(): BranchEntry[];
        appendCompaction(
          summary: string,
          firstKeptEntryId: string,
          tokensBefore: number,
          details: unknown,
          fromHook: boolean,
        ): string;
      };
      const entries = sm.getBranch();
      const boundaryStart = compactionBoundary(entries).index;
      const firstKeptIdx = entries.findIndex((e) => e.id === result.firstKeptEntryId);
      // A compaction that landed while we were summarizing moved the boundary past
      // our cut. Splicing it would re-include entries that are already summarized
      // and grow the live context (one stale splice took a session from ~178k to
      // 230k tokens, past its 240k window). Refuse; the caller re-prepares.
      if (firstKeptIdx <= boundaryStart) return false;
      sm.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, true);
      // Pi 0.87 made SessionManager canonical for provider context: assigning
      // agent.state.messages no longer replaces future request history, so rebuild
      // through the manager instead.
      session.refreshContext();
      return true;
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
      console.log(`[orcd] session model → ${provider}/${model}`);
    },

    getMessages() {
      const messages = session.messages;
      return Array.isArray(messages) ? [...messages] : [];
    },
  };
}
