/* oxlint-disable orchestrel/log-before-early-return -- pure config loader */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import type { ProviderAliases } from './subagent-policy';

export interface ModelDef {
  label: string;
  modelID: string;
  contextWindow: number;
}

export type ProviderType = 'anthropic' | 'bedrock' | 'google';

export interface ProviderDef {
  type?: ProviderType;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  authToken?: string;
  oauth?: string;
  region?: string;
  profile?: string;
  models: Record<string, ModelDef>;
  /** Runtime subagent model tiers, resolved by the Orchestrel policy extension. */
  aliases?: ProviderAliases;
  /** Granular runtime subagent agent → model key overrides (e.g. `Explore: haiku`). */
  agents?: Record<string, string>;
}

export interface MemoryProjectConfig {
  match: string[];
  apiUrl: string;
  apiKey: string;
  project: string;
}

export interface MemoryConfig {
  mode: 'stage' | 'write';
  provider: string;
  model: string;
  maxTurns: number;
  excerptTokens: number;
  stageDir: string;
  settleMs: number;
  telegram?: { botToken: string; chatId: string };
  projects: Record<string, MemoryProjectConfig>;
}

export interface OrchestrelConfig {
  listen: { host: string; port: number };
  authToken: string;
  name: string;
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel?: string;
  defaultCwd?: string;
  ringBufferSize: number;
  providers: Record<string, ProviderDef>;
  memory?: MemoryConfig;
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
          ...(rawAliases.subagent ? { subagent: String(rawAliases.subagent) } : {}),
          ...(rawAliases.lightweight ? { lightweight: String(rawAliases.lightweight) } : {}),
        }
      : undefined;

    const rawAgents = p.agents as Record<string, unknown> | undefined;
    const agents = rawAgents
      ? Object.fromEntries(Object.entries(rawAgents).map(([name, key]) => [name, String(key)]))
      : undefined;

    providers[id] = {
      ...(p.type ? { type: String(p.type) as ProviderType } : {}),
      ...(p.label ? { label: String(p.label) } : {}),
      ...(p.baseUrl ? { baseUrl: resolveEnvVars(String(p.baseUrl), env) } : {}),
      ...(p.apiKey ? { apiKey: resolveEnvVars(String(p.apiKey), env) } : {}),
      ...(p.authToken ? { authToken: resolveEnvVars(String(p.authToken), env) } : {}),
      ...(p.oauth ? { oauth: String(p.oauth) } : {}),
      ...(p.region ? { region: resolveEnvVars(String(p.region), env) } : {}),
      ...(p.profile ? { profile: resolveEnvVars(String(p.profile), env) } : {}),
      models,
      ...(aliases ? { aliases } : {}),
      ...(agents ? { agents } : {}),
    };
  }

  const rawListen = (raw.listen ?? {}) as Record<string, unknown>;
  const listen = {
    host: String(rawListen.host ?? '127.0.0.1'),
    port: Number(rawListen.port ?? 7420),
  };

  let memory: MemoryConfig | undefined;
  const rawMemory = raw.memory;
  if (rawMemory && typeof rawMemory === 'object') {
    const m = rawMemory as Record<string, unknown>;
    if (!m.provider || !m.model) {
      throw new Error('config: memory requires provider and model');
    }
    if (!m.projects || typeof m.projects !== 'object') {
      throw new Error('config: memory requires a projects map');
    }
    const projects: Record<string, MemoryProjectConfig> = {};
    for (const [key, p] of Object.entries(m.projects as Record<string, Record<string, unknown>>)) {
      if (!Array.isArray(p.match) || p.match.length === 0) {
        throw new Error(`config: memory project "${key}" requires match paths`);
      }
      if (!p.apiUrl || !p.apiKey || !p.project) {
        throw new Error(`config: memory project "${key}" requires apiUrl, apiKey, project`);
      }
      projects[key] = {
        match: p.match.map((x) => resolveEnvVars(String(x), env)),
        apiUrl: resolveEnvVars(String(p.apiUrl), env),
        apiKey: resolveEnvVars(String(p.apiKey), env),
        project: resolveEnvVars(String(p.project), env),
      };
    }
    memory = {
      mode: m.mode === 'write' ? 'write' : 'stage',
      provider: String(m.provider),
      model: String(m.model),
      maxTurns: Number(m.maxTurns ?? 30),
      excerptTokens: Number(m.excerptTokens ?? 24000),
      stageDir: String(m.stageDir ?? 'data/memory-staging'),
      settleMs: Number(m.settleMs ?? 600000),
      ...(m.telegram && typeof m.telegram === 'object'
        ? {
            telegram: {
              botToken: resolveEnvVars(String((m.telegram as Record<string, unknown>).botToken ?? ''), env),
              chatId: resolveEnvVars(String((m.telegram as Record<string, unknown>).chatId ?? ''), env),
            },
          }
        : {}),
      projects,
    };
  }

  return {
    listen,
    authToken: raw.authToken != null ? resolveEnvVars(String(raw.authToken), env) : '',
    name: raw.name != null ? String(raw.name) : 'local',
    defaultProvider: String(raw.defaultProvider ?? 'anthropic'),
    defaultModel: String(raw.defaultModel ?? 'claude-sonnet-4-6'),
    defaultThinkingLevel: raw.defaultThinkingLevel != null ? String(raw.defaultThinkingLevel) : undefined,
    defaultCwd: raw.defaultCwd != null ? String(raw.defaultCwd) : undefined,
    ringBufferSize: Number(raw.ringBufferSize ?? 5000),
    providers,
    ...(memory ? { memory } : {}),
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
