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
  claudeCodePath?: string;
  extraSettings?: string[];
  providers: Record<string, ProviderDef>;
  memoryUpsert?: MemoryUpsertConfig;
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

    providers[id] = {
      ...(p.type ? { type: String(p.type) as ProviderType } : {}),
      ...(p.label ? { label: String(p.label) } : {}),
      ...(p.baseUrl ? { baseUrl: resolveEnvVars(String(p.baseUrl), env) } : {}),
      ...(p.apiKey ? { apiKey: resolveEnvVars(String(p.apiKey), env) } : {}),
      ...(p.authToken ? { authToken: resolveEnvVars(String(p.authToken), env) } : {}),
      ...(p.region ? { region: resolveEnvVars(String(p.region), env) } : {}),
      ...(p.profile ? { profile: resolveEnvVars(String(p.profile), env) } : {}),
      models,
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

  const extraSettings = Array.isArray(raw.extraSettings)
    ? (raw.extraSettings as unknown[]).map((s) => resolveEnvVars(String(s), env))
    : undefined;

  return {
    socket: String(raw.socket ?? '~/.orc/orcd.sock'),
    defaultProvider: String(raw.defaultProvider ?? 'anthropic'),
    defaultModel: String(raw.defaultModel ?? 'claude-sonnet-4-6'),
    defaultCwd: raw.defaultCwd != null ? String(raw.defaultCwd) : undefined,
    claudeCodePath: raw.claudeCodePath != null ? resolveEnvVars(String(raw.claudeCodePath), env) : undefined,
    extraSettings,
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
