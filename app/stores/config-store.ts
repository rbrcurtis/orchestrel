import { makeAutoObservable } from 'mobx';
import type { ProvidersMap, ProviderConfig, ModelConfig, NodeInfo } from '../../src/shared/ws-protocol';

export class ConfigStore {
  // `providers` is the union of all connected nodes' providers, kept for the
  // existing provider/model selectors. `nodes` carries per-node connection
  // state + capabilities for node-aware forms and offline-card rendering.
  providers: ProvidersMap = {};
  nodes: NodeInfo[] = [];

  constructor() {
    makeAutoObservable(this);
  }

  hydrate(providers: ProvidersMap) {
    this.providers = providers;
  }

  hydrateNodes(nodes: NodeInfo[]) {
    this.nodes = nodes;
  }

  get connectedNodes(): NodeInfo[] {
    return this.nodes.filter((n) => n.connected);
  }

  nodeByName(name: string): NodeInfo | undefined {
    return this.nodes.find((n) => n.name === name);
  }

  providersForNode(name: string): ProvidersMap {
    return this.nodeByName(name)?.providers ?? {};
  }

  getModelsForNode(name: string, providerID: string): [string, ModelConfig][] {
    return Object.entries(this.providersForNode(name)[providerID]?.models ?? {});
  }

  defaultModelForNode(name: string, providerID: string): string {
    const keys = Object.keys(this.providersForNode(name)[providerID]?.models ?? {});
    return keys[0] ?? 'sonnet';
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
