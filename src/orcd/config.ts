import { loadConfig, parseConfig as parseSharedConfig, resolveEnvVars } from '../shared/config';
import type { OrchestrelConfig, MemoryUpsertConfig } from '../shared/config';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  authToken?: string;
  models: string[];
}

export interface OrcdConfig {
  socket: string;
  defaultProvider: string;
  defaultModel: string;
  defaultCwd?: string;
  providers: Record<string, ProviderConfig>;
  memoryUpsert?: MemoryUpsertConfig;
}

export { resolveEnvVars };

export function buildModelAliasEnv(models: string[]): Record<string, string> {
  const opus = models[0];
  const env: Record<string, string> = {};

  if (opus) {
    const sonnet = models[1] ?? opus;
    const haiku = models[2] ?? sonnet;

    env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
  }

  return env;
}

/** Flatten the shared config into orcd's historical shape (models as modelID list). */
function toOrcdShape(cfg: OrchestrelConfig): OrcdConfig {
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, p] of Object.entries(cfg.providers)) {
    providers[id] = {
      baseUrl: p.baseUrl ?? '',
      apiKey: p.apiKey ?? '',
      ...(p.authToken ? { authToken: p.authToken } : {}),
      models: Object.values(p.models).map((m) => m.modelID),
    };
  }
  return {
    socket: cfg.socket,
    defaultProvider: cfg.defaultProvider,
    defaultModel: cfg.defaultModel,
    defaultCwd: cfg.defaultCwd,
    providers,
    memoryUpsert: cfg.memoryUpsert,
  };
}

export function parseConfig(yamlStr: string, env: Record<string, string | undefined>): OrcdConfig {
  return toOrcdShape(parseSharedConfig(yamlStr, env));
}

export async function loadOrcdConfig(): Promise<OrcdConfig> {
  return toOrcdShape(loadConfig());
}
