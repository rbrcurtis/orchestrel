import { makeAutoObservable } from 'mobx';
import type { ProvidersMap, ProviderConfig, ModelConfig } from '../../src/shared/ws-protocol';

export class ConfigStore {
  providers: ProvidersMap = {};

  constructor() {
    makeAutoObservable(this);
  }

  hydrate(providers: ProvidersMap) {
    this.providers = providers;
  }

  getProvider(id: string): ProviderConfig | undefined {
    return this.providers[id];
  }

  /** Get model entries for a provider as [alias, config] pairs */
  getModels(providerID: string): [string, ModelConfig][] {
    const provider = this.providers[providerID];
    if (!provider) return [];
    return Object.entries(provider.models);
  }

  /** Get a specific model config */
  getModel(providerID: string, modelAlias: string): ModelConfig | undefined {
    return this.providers[providerID]?.models[modelAlias];
  }

  /** Get the first model alias for a provider */
  getDefaultModel(providerID: string): string {
    const provider = this.providers[providerID];
    if (!provider) return 'sonnet';
    const keys = Object.keys(provider.models);
    return keys[0] ?? 'sonnet';
  }

  /** All provider entries as [id, config] pairs */
  get allProviders(): [string, ProviderConfig][] {
    return Object.entries(this.providers);
  }
}
