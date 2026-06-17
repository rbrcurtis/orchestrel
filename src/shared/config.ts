/* oxlint-disable orchestrel/log-before-early-return -- pure config loader */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

export interface ModelDef {
  label: string;
  modelID: string;
  contextWindow: number;
}

export type ProviderType = 'anthropic' | 'bedrock';

export interface ProviderDef {
  type?: ProviderType;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  authToken?: string;
  region?: string;
  profile?: string;
  models: Record<string, ModelDef>;
  aliases?: {
    primary?: string;
    subagent?: string;
    lightweight?: string;
  };
}

export interface MemoryUpsertConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
}

export interface OrchestrelConfig {
  socket: string;
  defaultProvider: string;
  defaultModel: string;
  defaultCwd?: string;
  providers: Record<string, ProviderDef>;
  memoryUpsert?: MemoryUpsertConfig;
}

/**
 * Map provider models to SDK model aliases (opus/sonnet/haiku).
 *
 * The Agent SDK uses these aliases when spawning subagents — e.g. Explore agents
 * use the haiku alias for lightweight work. This tiered mapping is intentional:
 * it lets providers offer a big model for primary work and smaller/faster models
 * for subagents.
 *
 * If `aliases` is provided, resolves each semantic name (primary/subagent/lightweight)
 * to the model key's modelID. Unspecified aliases default to `primary`.
 * If `aliases` is absent, falls back to positional assignment from the models map.
 *
 * CAVEAT: On single-model servers (like oMLX on a single Mac), having different
 * models across tiers causes model thrashing — the server must unload the primary
 * model to load a subagent model and vice versa. For such providers, set all
 * aliases to the same model key.
 */
export function buildModelAliasEnv(
  models: Record<string, ModelDef>,
  aliases?: { primary?: string; subagent?: string; lightweight?: string },
): Record<string, string> {
  const env: Record<string, string> = {};

  if (aliases) {
    const resolve = (key: string | undefined, fallback: string | undefined): string | undefined => {
      const k = key ?? fallback;
      return k ? models[k]?.modelID : undefined;
    };
    const primary = resolve(aliases.primary, Object.keys(models)[0]);
    if (!primary) return env;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = primary;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = resolve(aliases.subagent, aliases.primary) ?? primary;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = resolve(aliases.lightweight, aliases.primary) ?? primary;
  } else {
    // Positional fallback: 1st→opus, 2nd→sonnet, 3rd→haiku
    const modelIds = Object.values(models).map((m) => m.modelID);
    const [first, second = first, third = second] = modelIds;
    if (first) {
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = first;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = second;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = third;
    }
  }

  return env;
}

/** Replace `${VAR}` with values from env. Unset vars become empty string. */
export function resolveEnvVars(str: string, env: Record<string, string | undefined>): string {
  return str.replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? '');
}

export function parseConfig(
  yamlStr: string,
  env: Record<string, string | undefined>,
): OrchestrelConfig {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;

  if (!raw.providers || typeof raw.providers !== 'object') {
    throw new Error('config: "providers" section is required');
  }

  const providers: Record<string, ProviderDef> = {};
  for (const [id, p] of Object.entries(raw.providers as Record<string, Record<string, unknown>>)) {
    if (!p.models || typeof p.models !== 'object') {
      throw new Error(`config: provider "${id}" requires a models map`);
    }

    const models: Record<string, ModelDef> = {};
    for (const [alias, m] of Object.entries(p.models as Record<string, Record<string, unknown>>)) {
      if (!m.modelID) {
        throw new Error(`config: provider "${id}" model "${alias}" requires modelID`);
      }
      models[alias] = {
        label: String(m.label ?? alias),
        modelID: resolveEnvVars(String(m.modelID), env),
        contextWindow: Number(m.contextWindow ?? 200000),
      };
    }

    const rawAliases = p.aliases as Record<string, string> | undefined;
    const aliases = rawAliases
      ? {
          ...(rawAliases.primary ? { primary: String(rawAliases.primary) } : {}),
          ...(rawAliases.subagent ? { subagent: String(rawAliases.subagent) } : {}),
          ...(rawAliases.lightweight ? { lightweight: String(rawAliases.lightweight) } : {}),
        }
      : undefined;

    providers[id] = {
      ...(p.type ? { type: String(p.type) as ProviderType } : {}),
      ...(p.label ? { label: String(p.label) } : {}),
      ...(p.baseUrl ? { baseUrl: resolveEnvVars(String(p.baseUrl), env) } : {}),
      ...(p.apiKey ? { apiKey: resolveEnvVars(String(p.apiKey), env) } : {}),
      ...(p.authToken ? { authToken: resolveEnvVars(String(p.authToken), env) } : {}),
      ...(p.region ? { region: resolveEnvVars(String(p.region), env) } : {}),
      ...(p.profile ? { profile: resolveEnvVars(String(p.profile), env) } : {}),
      models,
      ...(aliases ? { aliases } : {}),
    };
  }

  const mu = raw.memoryUpsert as Record<string, unknown> | undefined;
  const memoryUpsert: MemoryUpsertConfig | undefined = mu
    ? {
        enabled: Boolean(mu.enabled ?? false),
        baseUrl: resolveEnvVars(String(mu.baseUrl ?? 'http://localhost:3100'), env),
        apiKey: resolveEnvVars(String(mu.apiKey ?? ''), env),
      }
    : undefined;

  return {
    socket: String(raw.socket ?? '~/.orc/orcd.sock'),
    defaultProvider: String(raw.defaultProvider ?? 'anthropic'),
    defaultModel: String(raw.defaultModel ?? 'claude-sonnet-4-6'),
    defaultCwd: raw.defaultCwd != null ? String(raw.defaultCwd) : undefined,
    providers,
    memoryUpsert,
  };
}

/** Resolve config path — `ORC_CONFIG` env wins, otherwise `./config.yaml`. */
export function configPath(): string {
  return process.env.ORC_CONFIG ?? resolve(process.cwd(), 'config.yaml');
}

let cached: OrchestrelConfig | null = null;

export function loadConfig(): OrchestrelConfig {
  if (cached) return cached;
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(
      `Config not found at ${path}. Copy config.example.yaml to config.yaml and fill in your providers.`,
    );
  }
  const content = readFileSync(path, 'utf-8');
  cached = parseConfig(content, process.env as Record<string, string | undefined>);
  return cached;
}

/** Test-only: clear cached config. */
export function resetConfigCache(): void {
  cached = null;
}
