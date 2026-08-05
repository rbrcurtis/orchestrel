import type { ModelDef, OrchestrelConfig, ProviderType } from '../shared/config';
import { loadConfig, parseConfig as parseSharedConfig, resolveEnvVars } from '../shared/config';
import type { ProviderAliases } from '../shared/subagent-policy';

export interface ProviderConfig {
  type: ProviderType;
  label?: string;
  baseUrl: string;
  apiKey: string;
  authToken?: string;
  oauth?: string;
  region?: string;
  profile?: string;
  models: Record<string, ModelDef>;
  modelLabels?: Record<string, { alias: string; label: string; contextWindow: number }>;
  aliases?: ProviderAliases;
  agents?: Record<string, string>;
}

export interface OrcdConfig {
  listen: { host: string; port: number };
  authToken: string;
  name: string;
  defaultProvider: string;
  defaultModel: string;
  defaultCwd?: string;
  ringBufferSize: number;
  providers: Record<string, ProviderConfig>;
}

export { resolveEnvVars };

/** Flatten the shared config into orcd's historical shape (models as modelID list). */
function toOrcdShape(cfg: OrchestrelConfig): OrcdConfig {
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, p] of Object.entries(cfg.providers)) {
    const modelLabels: Record<string, { alias: string; label: string; contextWindow: number }> = {};
    for (const [alias, m] of Object.entries(p.models)) {
      modelLabels[m.modelID] = { alias, label: m.label, contextWindow: m.contextWindow };
    }
    providers[id] = {
      type: p.type ?? 'anthropic',
      ...(p.label ? { label: p.label } : {}),
      baseUrl: p.baseUrl ?? '',
      apiKey: p.apiKey ?? '',
      ...(p.authToken ? { authToken: p.authToken } : {}),
      ...(p.oauth ? { oauth: p.oauth } : {}),
      ...(p.region ? { region: p.region } : {}),
      ...(p.profile ? { profile: p.profile } : {}),
      models: p.models,
      modelLabels,
      ...(p.aliases ? { aliases: p.aliases } : {}),
      ...(p.agents ? { agents: p.agents } : {}),
    };
  }
  return {
    listen: cfg.listen,
    authToken: cfg.authToken,
    name: cfg.name,
    defaultProvider: cfg.defaultProvider,
    defaultModel: cfg.defaultModel,
    defaultCwd: cfg.defaultCwd,
    ringBufferSize: cfg.ringBufferSize,
    providers,
  };
}

export function parseConfig(yamlStr: string, env: Record<string, string | undefined>): OrcdConfig {
  return toOrcdShape(parseSharedConfig(yamlStr, env));
}

export async function loadOrcdConfig(): Promise<OrcdConfig> {
  return toOrcdShape(loadConfig());
}
