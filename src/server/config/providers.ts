import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';

const modelConfigSchema = z.object({
  label: z.string(),
  modelID: z.string(),
  contextWindow: z.number(),
});

const providerConfigSchema = z.object({
  label: z.string(),
  models: z.record(z.string(), modelConfigSchema),
});

const providersFileSchema = z.object({
  providers: z.record(z.string(), providerConfigSchema),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProvidersConfig = z.infer<typeof providersFileSchema>;

const CONFIG_PATH = resolve(process.cwd(), 'providers.json');

let cached: ProvidersConfig | null = null;

export function loadProviders(): ProvidersConfig {
  if (cached) return cached;

  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Provider config not found at ${CONFIG_PATH}. Copy providers.example.json to providers.json`,
    );
  }

  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = providersFileSchema.parse(JSON.parse(raw));
  cached = parsed;
  return parsed;
}

/** Get the serializable providers map for the frontend */
export function getProvidersForClient(): ProvidersConfig['providers'] {
  return loadProviders().providers;
}

/** Look up a model config by provider + model alias */
export function getModelConfig(providerID: string, modelAlias: string): ModelConfig | undefined {
  const config = loadProviders();
  return config.providers[providerID]?.models[modelAlias];
}

/** Get the first model alias for a provider (used as default) */
export function getDefaultModel(providerID: string): string {
  const config = loadProviders();
  const provider = config.providers[providerID];
  if (!provider) return 'sonnet';
  const keys = Object.keys(provider.models);
  return keys[0] ?? 'sonnet';
}
