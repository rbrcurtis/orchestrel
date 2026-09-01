/* Consolidation agent: one pi-ai ModelRuntime tool loop per session. Mirrors
 * src/orcd/pi-runtime.ts provider registration. In stage mode, search executes
 * and store/update/delete are recorded as StagedOps; in write mode they execute
 * against the memory API and are still recorded for the run log. */
import type { Api, Message, Model, Tool, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { Type } from '@earendil-works/pi-ai';
import { getAgentDir, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ProviderConfig as ProviderConfigInput } from '@earendil-works/pi-coding-agent';
import type { MemoryConfig, OrchestrelConfig, ProviderDef } from '../../shared/config';
import { SECRETS_PATTERN, type Excerpt } from './excerpt';
import { loadMemory, searchMemories, storeMemory, updateMemory } from './memory-api';
import type { MemoryServer, StagedOp } from './memory-api';
import { SYSTEM_PROMPT } from './prompts';

const ANONYMOUS_API_KEY = 'anonymous';

export interface ConsolidateOpts {
  excerpt: Excerpt;
  server: MemoryServer;
  runtime: ModelRuntime;
  model: Model<Api>;
  maxTurns: number;
  mode: 'stage' | 'write';
}

export async function buildModel(
  cfg: OrchestrelConfig,
  memory: MemoryConfig,
): Promise<{ runtime: ModelRuntime; model: Model<Api> }> {
  const provider = cfg.providers[memory.provider];
  if (!provider) throw new Error(`memory: provider "${memory.provider}" not in config`);
  const modelDef = provider.models[memory.model];
  if (!modelDef) throw new Error(`memory: model "${memory.model}" not in provider "${memory.provider}"`);

  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(memory.provider, toProviderConfig(provider, modelDef.modelID));
  const model = registry.find(memory.provider, modelDef.modelID);
  if (!model) throw new Error(`memory: failed to resolve model ${memory.provider}/${modelDef.modelID}`);
  return { runtime, model };
}

function toProviderConfig(provider: ProviderDef, modelId: string): ProviderConfigInput {
  return {
    name: provider.label ?? 'memory',
    api: 'anthropic-messages' as const,
    baseUrl: provider.baseUrl || 'https://api.anthropic.com',
    apiKey: provider.apiKey || provider.authToken || ANONYMOUS_API_KEY,
    models: [
      {
        id: modelId,
        name: modelId,
        api: 'anthropic-messages' as const,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 64_000,
      },
    ],
  };
}

const tools: Tool[] = [
  {
    name: 'search_memory',
    description: 'Search existing memories for duplicates or related knowledge.',
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'read_memory',
    description: 'Read the full text of one memory by id. Required before updating a memory.',
    parameters: Type.Object({
      id: Type.String(),
    }),
  },
  {
    name: 'store_memory',
    description: 'Store a new memory (one concept).',
    parameters: Type.Object({
      title: Type.String(),
      text: Type.String(),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
  },
  {
    name: 'update_memory',
    description: 'Update an existing memory by id. Requires read_memory(id) first. The rewrite must preserve all still-valid facts from the existing text.',
    parameters: Type.Object({
      id: Type.String(),
      title: Type.Optional(Type.String()),
      text: Type.String(),
    }),
  },
];

export async function consolidate(opts: ConsolidateOpts): Promise<StagedOp[]> {
  const { excerpt, server, runtime, model, maxTurns, mode } = opts;
  const ops: StagedOp[] = [];
  const readIds = new Set<string>();
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: `Session: ${excerpt.sessionId} (${excerpt.cwd})\n\n${excerpt.text}` }], timestamp: Date.now() },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const msg = await runtime.completeSimple(model, { systemPrompt: SYSTEM_PROMPT, messages, tools });
    messages.push(msg);
    const calls = msg.content.filter((b): b is ToolCall => b.type === 'toolCall');
    if (calls.length === 0) break;
    for (const call of calls) {
      const result = await runTool(call, server, mode, ops, readIds);
      messages.push(result);
    }
  }

  return dedupeOps(ops);
}

async function runTool(
  call: ToolCall,
  server: MemoryServer,
  mode: 'stage' | 'write',
  ops: StagedOp[],
  readIds: Set<string>,
): Promise<ToolResultMessage> {
  try {
    const args = call.arguments as Record<string, unknown>;
    const text = (s: string): string => (SECRETS_PATTERN.test(s) ? '[redacted]' : s);
    switch (call.name) {
      case 'search_memory': {
        const hits = await searchMemories(server, String(args.query), Number(args.limit ?? 10));
        return toolResult(call, JSON.stringify(hits.map((h) => ({ id: h.id, title: h.title, score: h.score }))));
      }
      case 'read_memory': {
        const id = String(args.id);
        const existing = await loadMemory(server, id);
        if (!existing) return toolResult(call, `memory ${id} not found`, true);
        readIds.add(id);
        return toolResult(call, `${existing.title}\n\n${existing.text}`);
      }
      case 'store_memory': {
        const title = String(args.title);
        const body = text(String(args.text));
        ops.push({ op: 'store', title, text: body, ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}) });
        if (mode === 'write') {
          const { id } = await storeMemory(server, { title, text: body });
          return toolResult(call, JSON.stringify({ id }));
        }
        return toolResult(call, 'recorded (stage mode)');
      }
      case 'update_memory': {
        const id = String(args.id);
        if (!readIds.has(id)) {
          return toolResult(call, `error: call read_memory(${id}) first — you must see the existing text before replacing it`, true);
        }
        const body = text(String(args.text));
        ops.push({ op: 'update', id, text: body, ...(args.title ? { title: String(args.title) } : {}) });
        if (mode === 'write') {
          const { success } = await updateMemory(server, { id, text: body, ...(args.title ? { title: String(args.title) } : {}) });
          return toolResult(call, JSON.stringify({ success }));
        }
        return toolResult(call, 'recorded (stage mode)');
      }
      default:
        return toolResult(call, `unknown tool ${call.name}`, true);
    }
  } catch (err) {
    return toolResult(call, `error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

function toolResult(call: ToolCall, text: string, isError = false): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  };
}

function dedupeOps(ops: StagedOp[]): StagedOp[] {
  // First store of a title wins; last update of an id wins (the model may
  // revise an update after seeing the existing text via the tool result).
  const seen = new Map<string, StagedOp>();
  for (const op of ops) {
    if (op.op === 'skip') continue;
    const key = op.op === 'store' ? `store:${op.title}` : `${op.op}:${op.id}`;
    if (op.op === 'store' && seen.has(key)) continue;
    seen.set(key, op);
  }
  return [...seen.values()];
}
