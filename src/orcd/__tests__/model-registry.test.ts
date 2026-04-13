import { describe, it, expect } from 'vitest';
import { apiForProvider, resolveModel } from '../model-registry';
import type { ProviderConfig } from '../config';

const anthropicProvider: ProviderConfig = {
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  models: ['claude-sonnet-4-6'],
};

const openRouterProvider: ProviderConfig = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'or-test',
  models: ['anthropic/claude-sonnet-4-6'],
};

const openAiProvider: ProviderConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-openai-test',
  models: ['gpt-4o'],
};

const kppProvider: ProviderConfig = {
  baseUrl: 'http://localhost:3019',
  apiKey: 'sk-ant-test',
  models: ['claude-sonnet-4-6'],
};

describe('apiForProvider', () => {
  it('returns anthropic-messages for direct Anthropic URLs', () => {
    expect(apiForProvider('https://api.anthropic.com')).toBe('anthropic-messages');
  });

  it('returns anthropic-messages for KPP proxy URLs', () => {
    expect(apiForProvider('http://localhost:3019')).toBe('anthropic-messages');
  });

  it('returns openai-completions for openrouter.ai URLs', () => {
    expect(apiForProvider('https://openrouter.ai/api/v1')).toBe('openai-completions');
  });

  it('returns openai-completions for openai.com URLs', () => {
    expect(apiForProvider('https://api.openai.com/v1')).toBe('openai-completions');
  });

  it('returns google-generative-ai for generativelanguage.googleapis.com URLs', () => {
    expect(apiForProvider('https://generativelanguage.googleapis.com/v1beta')).toBe('google-generative-ai');
  });

  it('returns google-generative-ai for vertex URLs', () => {
    expect(apiForProvider('https://us-east5-aiplatform.googleapis.com/v1beta1')).toBe('google-generative-ai');
  });
});

describe('resolveModel', () => {
  it('creates correct Model for Anthropic provider', () => {
    const model = resolveModel('claude-sonnet-4-6', 'anthropic', anthropicProvider);
    expect(model.id).toBe('claude-sonnet-4-6');
    expect(model.name).toBe('claude-sonnet-4-6');
    expect(model.api).toBe('anthropic-messages');
    expect(model.provider).toBe('anthropic');
    expect(model.baseUrl).toBe('https://api.anthropic.com');
    expect(model.input).toEqual(['text', 'image']);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('creates correct Model for OpenRouter provider', () => {
    const model = resolveModel('anthropic/claude-sonnet-4-6', 'openrouter', openRouterProvider);
    expect(model.id).toBe('anthropic/claude-sonnet-4-6');
    expect(model.api).toBe('openai-completions');
    expect(model.provider).toBe('openrouter');
    expect(model.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('uses providerName as provider for non-anthropic APIs', () => {
    const model = resolveModel('gpt-4o', 'openai', openAiProvider);
    expect(model.provider).toBe('openai');
  });

  it('uses "anthropic" as provider for anthropic-messages API regardless of providerName', () => {
    const model = resolveModel('claude-sonnet-4-6', 'kpp', kppProvider);
    expect(model.api).toBe('anthropic-messages');
    expect(model.provider).toBe('anthropic');
  });

  it('reasoning=true for claude-opus-4* models', () => {
    const model = resolveModel('claude-opus-4-6', 'anthropic', anthropicProvider);
    expect(model.reasoning).toBe(true);
  });

  it('reasoning=true for claude-sonnet-4* models', () => {
    const model = resolveModel('claude-sonnet-4-6', 'anthropic', anthropicProvider);
    expect(model.reasoning).toBe(true);
  });

  it('reasoning=true for claude-sonnet-4-5', () => {
    const model = resolveModel('claude-sonnet-4-5', 'anthropic', anthropicProvider);
    expect(model.reasoning).toBe(true);
  });

  it('reasoning=false for non-reasoning models', () => {
    const model = resolveModel('google/gemma-4-31b', 'openrouter', openRouterProvider);
    expect(model.reasoning).toBe(false);
  });

  it('reasoning=false for claude-haiku-3-5', () => {
    const haiku: ProviderConfig = {
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      models: ['claude-haiku-3-5'],
    };
    const model = resolveModel('claude-haiku-3-5', 'anthropic', haiku);
    expect(model.reasoning).toBe(false);
  });

  it('uses known context window for claude-sonnet-4-6', () => {
    const model = resolveModel('claude-sonnet-4-6', 'anthropic', anthropicProvider);
    expect(model.contextWindow).toBe(200_000);
  });

  it('uses known maxTokens for claude-sonnet-4-6', () => {
    const model = resolveModel('claude-sonnet-4-6', 'anthropic', anthropicProvider);
    expect(model.maxTokens).toBe(64_000);
  });

  it('uses known context window for gemma models', () => {
    const model = resolveModel('google/gemma-4-31b', 'openrouter', openRouterProvider);
    expect(model.contextWindow).toBe(128_000);
  });

  it('unknown models get default context window and maxTokens', () => {
    const model = resolveModel('some-unknown-model', 'openrouter', openRouterProvider);
    expect(model.contextWindow).toBe(200_000);
    expect(model.maxTokens).toBe(16_384);
  });
});
