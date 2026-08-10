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

export type ProviderType = 'anthropic' | 'bedrock';

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

export interface FullCompactionDef {
  provider: string;
  model: string;
  timeoutMs: number;
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
  fullCompaction?: FullCompactionDef;
  providers: Record<string, ProviderDef>;
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

  let fullCompaction: FullCompactionDef | undefined;
  if (raw.fullCompaction !== undefined) {
    if (!raw.fullCompaction || typeof raw.fullCompaction !== 'object' || Array.isArray(raw.fullCompaction)) {
      throw new Error('config: "fullCompaction" must be a map');
    }
    const value = raw.fullCompaction as Record<string, unknown>;
    const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
    const model = typeof value.model === 'string' ? value.model.trim() : '';
    if (!provider || !providers[provider]) {
      throw new Error(`config: fullCompaction provider "${provider}" is not configured`);
    }
    if (!model || !providers[provider].models[model]) {
      throw new Error(`config: fullCompaction model "${provider}/${model}" is not configured`);
    }
    const timeoutMs = Number(value.timeoutMs ?? 300_000);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('config: fullCompaction timeoutMs must be a positive integer');
    }
    fullCompaction = { provider, model, timeoutMs };
  }

  const rawListen = (raw.listen ?? {}) as Record<string, unknown>;
  const listen = {
    host: String(rawListen.host ?? '127.0.0.1'),
    port: Number(rawListen.port ?? 7420),
  };

  return {
    listen,
    authToken: raw.authToken != null ? resolveEnvVars(String(raw.authToken), env) : '',
    name: raw.name != null ? String(raw.name) : 'local',
    defaultProvider: String(raw.defaultProvider ?? 'anthropic'),
    defaultModel: String(raw.defaultModel ?? 'claude-sonnet-4-6'),
    defaultThinkingLevel: raw.defaultThinkingLevel != null ? String(raw.defaultThinkingLevel) : undefined,
    defaultCwd: raw.defaultCwd != null ? String(raw.defaultCwd) : undefined,
    ringBufferSize: Number(raw.ringBufferSize ?? 5000),
    ...(fullCompaction ? { fullCompaction } : {}),
    providers,
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
