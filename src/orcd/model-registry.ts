import type { Model, Api, Provider } from '@oh-my-pi/pi-ai';
import type { ProviderConfig } from './config';

const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-haiku-3-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'google/gemma-4-31b': 128_000,
  'google/gemma-4-27b': 128_000,
};

const KNOWN_MAX_TOKENS: Record<string, number> = {
  'claude-sonnet-4-6': 64_000,
  'claude-opus-4-6': 64_000,
  'claude-haiku-3-5': 8_192,
  'claude-sonnet-4-5': 64_000,
};

export function apiForProvider(baseUrl: string): Api {
  if (baseUrl.includes('openrouter.ai') || baseUrl.includes('openai.com')) {
    return 'openai-completions';
  }
  if (baseUrl.includes('generativelanguage.googleapis.com') || baseUrl.includes('vertex') || baseUrl.includes('aiplatform.googleapis.com')) {
    return 'google-generative-ai';
  }
  return 'anthropic-messages';
}

export function resolveModel(modelId: string, providerName: string, providerConfig: ProviderConfig): Model {
  const api = apiForProvider(providerConfig.baseUrl);
  const provider: Provider = api === 'anthropic-messages' ? 'anthropic' : providerName;
  const reasoning = /^claude-(opus|sonnet)-4/.test(modelId);

  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl: providerConfig.baseUrl,
    reasoning,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: KNOWN_CONTEXT_WINDOWS[modelId] ?? 200_000,
    maxTokens: KNOWN_MAX_TOKENS[modelId] ?? 16_384,
  };
}
