import type { ProviderConfig } from './config';

export interface PiProviderRuntimeConfig {
  providerId: string;
  modelId: string;
  type: string;
  baseUrl?: string;
  apiKey?: string;
  authToken?: string;
  region?: string;
  profile?: string;
  env: Record<string, string>;
}

export function buildPiProviderRuntimeConfig(
  providerId: string,
  provider: ProviderConfig,
  modelId: string,
): PiProviderRuntimeConfig {
  return {
    providerId,
    modelId,
    type: provider.type,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    ...(provider.authToken ? { authToken: provider.authToken } : {}),
    ...(provider.region ? { region: provider.region } : {}),
    ...(provider.profile ? { profile: provider.profile } : {}),
    env: { ...provider.modelAliasEnv },
  };
}
