import { loadConfig, parseConfig as parseSharedConfig, resolveEnvVars } from '../shared/config';
import type { OrchestrelConfig, MemoryUpsertConfig, ProviderType } from '../shared/config';

export interface ProviderConfig {
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  authToken?: string;
  region?: string;
  profile?: string;
  models: string[];
}

export interface OrcdConfig {
  socket: string;
  defaultProvider: string;
  defaultModel: string;
  defaultCwd?: string;
  claudeCodePath?: string;
  extraSettings?: string[];
  providers: Record<string, ProviderConfig>;
  memoryUpsert?: MemoryUpsertConfig;
}

export { resolveEnvVars };

/** Flatten the shared config into orcd's historical shape (models as modelID list). */
function toOrcdShape(cfg: OrchestrelConfig): OrcdConfig {
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, p] of Object.entries(cfg.providers)) {
    providers[id] = {
      type: p.type ?? 'anthropic',
      baseUrl: p.baseUrl ?? '',
      apiKey: p.apiKey ?? '',
      ...(p.authToken ? { authToken: p.authToken } : {}),
      ...(p.region ? { region: p.region } : {}),
      ...(p.profile ? { profile: p.profile } : {}),
      models: Object.values(p.models).map((m) => m.modelID),
    };
  }
  return {
    socket: cfg.socket,
    defaultProvider: cfg.defaultProvider,
    defaultModel: cfg.defaultModel,
    defaultCwd: cfg.defaultCwd,
    claudeCodePath: cfg.claudeCodePath,
    extraSettings: cfg.extraSettings,
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
