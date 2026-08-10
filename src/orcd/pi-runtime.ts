/* oxlint-disable orchestrel/log-before-early-return -- pure SDK boundary wrapper returns mapped values/no-op fallbacks without session context */
import { createHash } from 'node:crypto';
import { AuthStorage, DEFAULT_COMPACTION_SETTINGS, DefaultResourceLoader, ModelRegistry, SessionManager, createAgentSession, createEventBus, findCutPoint, generateSummary, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, AuthStorage as PiAuthStorage, CompactionResult, ProviderConfig as ProviderConfigInput } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { FullCompactionDef, ModelDef, ProviderType } from '../shared/config';
import { buildSubagentPolicy, cleanupManagedSubagentFiles } from '../shared/subagent-policy';
import { createOrchestrelFullCompactionExtension } from '../pi-extensions/orchestrel-full-compaction';
import { createOrchestrelSubagentPolicyExtension } from '../pi-extensions/orchestrel-subagent-policy';
import { expandInlineCommands } from './inline-commands';
import type { ProviderAliases } from '../shared/subagent-policy';

const EMPTY_API_KEY_ENV = 'ORCHESTREL_PI_EMPTY_API_KEY';
const DISPLAY_PROMPT_ENTRY = 'orchestrel-display-prompt';

export interface CreatePiRuntimeSessionOpts {
  cwd: string;
  providerId: string;
  modelId: string;
  sessionId?: string;
  effort?: string;
  provider?: RuntimeProviderConfig;
  fullCompaction?: FullCompactionDef;
  providers?: Record<string, RuntimeProviderConfig>;
}

export interface RuntimeProviderConfig {
  type: ProviderType;
  label?: string;
  baseUrl: string;
  apiKey: string;
  authToken?: string;
  oauth?: string;
  models: Record<string, ModelDef>;
  aliases?: ProviderAliases;
  agents?: Record<string, string>;
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
  /**
   * Temporary diagnostic probe for the "chat lost when a background subagent
   * finishes" bug: reports the SessionManager instance tag + current leaf so we
   * can catch the tree fork (notification appended off a stale leaf, orphaning
   * interleaved user turns). Remove once the fork's origin is confirmed.
   */
  debugLeafState(prevLeafId?: string | null): {
    tag: string;
    leafId: string | null;
    count: number;
    lastId: string | null;
    lastParentId: string | null;
    // False when prevLeafId is set but is NOT an ancestor of the current leaf —
    // i.e. the active branch diverged and everything appended after prevLeafId on
    // the old branch is now orphaned. This is the fork we're hunting.
    prevIsAncestor: boolean;
  };
}

// Monotonic tag so we can tell distinct SessionManager instances apart in logs
// (a tag change between the interleaved chat prompt and the subagent-completion
// append would prove a desynced/duplicate manager is the fork's origin).
let managerTagSeq = 0;

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
  adaptive: boolean,
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
      // Adaptive thinking (card thinking level = adaptive): let the endpoint
      // decide how much to think instead of capping it with a fixed budget, and
      // advertise xhigh so 'max' effort isn't clamped back to 'high'.
      ...(adaptive
        ? { compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { xhigh: 'xhigh' } }
        : {}),
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
  const providersToRegister = new Set<string>();
  if (opts.provider) providersToRegister.add(opts.providerId);
  if (opts.fullCompaction) providersToRegister.add(opts.fullCompaction.provider);
  for (const id of providersToRegister) {
    const provider = opts.providers?.[id] ?? (id === opts.providerId ? opts.provider : undefined);
    if (!provider) throw new Error(`Pi provider not found: ${id}`);
    const runtimeId = usesBuiltInProvider(provider) ? provider.type : id;
    setRuntimeApiKey(authStorage, runtimeId, provider.apiKey || provider.authToken);
    if (runtimeId === id) {
      registerOrchestrelProvider(modelRegistry, id, provider, id === opts.providerId && isAdaptiveEffort(opts.effort));
    }
  }

  const modelId = opts.provider?.models[opts.modelId]?.modelID ?? opts.modelId;
  const model = modelRegistry.find(providerId, modelId);
  if (!model) throw new Error(`Pi model not found: ${providerId}/${opts.modelId}`);

  let fullCompactionFactory;
  if (opts.fullCompaction) {
    const provider = opts.providers?.[opts.fullCompaction.provider];
    if (!provider) throw new Error(`Pi compaction provider not found: ${opts.fullCompaction.provider}`);
    const id = usesBuiltInProvider(provider) ? provider.type : opts.fullCompaction.provider;
    const configuredModel = provider.models[opts.fullCompaction.model];
    const compactionModel = configuredModel && modelRegistry.find(id, configuredModel.modelID);
    if (!compactionModel) {
      throw new Error(`Pi compaction model not found: ${opts.fullCompaction.provider}/${opts.fullCompaction.model}`);
    }
    fullCompactionFactory = createOrchestrelFullCompactionExtension({
      modelRegistry,
      model: compactionModel,
      timeoutMs: opts.fullCompaction.timeoutMs,
    });
  }

  // Legacy managed files were process-global configuration. Remove them before
  // discovery; the policy extension below is isolated to this session's loader.
  cleanupManagedSubagentFiles(opts.cwd);
  const policy = buildSubagentPolicy(providerId, modelId, opts.provider ?? {
    models: { [opts.modelId]: { label: opts.modelId, modelID: modelId, contextWindow: 200_000 } },
  });
  const eventBus = createEventBus();
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir,
    eventBus,
    extensionFactories: [
      createOrchestrelSubagentPolicyExtension(policy, {
        onDecision: ({ agentType, decision }) => {
          if ('model' in decision) console.log(`[orcd] subagent ${agentType} -> ${decision.model} (${decision.source})`);
        },
      }),
      ...(fullCompactionFactory ? [fullCompactionFactory] : []),
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

  const result = await createAgentSession({
    cwd: opts.cwd,
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager,
    model: model as Model<Api>,
    thinkingLevel: effortToThinkingLevel(opts.effort),
  });
  const session = result.session;

  // Tag the live SessionManager so leaf-probe logs can distinguish instances.
  const taggedManager = session.sessionManager as unknown as { __orcdTag?: string };
  if (!taggedManager.__orcdTag) taggedManager.__orcdTag = `m${++managerTagSeq}`;

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
      const expanded = expandInlineCommands(session, text);
      if (expanded !== text) {
        // Pi persists the expanded skill/template as the user message. Keep the
        // invocation beside it as non-context metadata so transcript history can
        // show what Ryan typed without exposing the injected instructions.
        session.sessionManager.appendCustomEntry(DISPLAY_PROMPT_ENTRY, {
          displayText: text,
          expandedHash: createHash('sha256').update(expanded).digest('hex'),
        });
      }
      await session.prompt(expanded, promptOpts);
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
      // Note: 'adaptive' maps to 'high' here — the adaptive/budget distinction
      // lives in the provider registration made at session creation and can't
      // be flipped on a live session. A card must start a fresh session to
      // switch modes.
      if (!canSetThinkingLevel(session)) return;
      session.setThinkingLevel(effortToThinkingLevel(effort));
    },

    getMessages() {
      const messages = session.messages;
      return Array.isArray(messages) ? [...messages] : [];
    },

    debugLeafState(prevLeafId?: string | null) {
      const sm = session.sessionManager as unknown as {
        __orcdTag?: string;
        getLeafId(): string | null;
        getEntry(id: string): { id: string; parentId: string | null } | undefined;
        getEntries(): Array<{ id: string; parentId: string | null }>;
      };
      const entries = sm.getEntries();
      const last = entries[entries.length - 1];
      const leafId = sm.getLeafId();

      let prevIsAncestor = true;
      if (prevLeafId) {
        prevIsAncestor = false;
        let cur = leafId ? sm.getEntry(leafId) : undefined;
        // Bounded walk up the parent chain from the current leaf to the root.
        for (let i = 0; cur && i <= entries.length; i++) {
          if (cur.id === prevLeafId) { prevIsAncestor = true; break; }
          cur = cur.parentId ? sm.getEntry(cur.parentId) : undefined;
        }
      }

      return {
        tag: sm.__orcdTag ?? '?',
        leafId,
        count: entries.length,
        lastId: last?.id ?? null,
        lastParentId: last?.parentId ?? null,
        prevIsAncestor,
      };
    },
  };
}
