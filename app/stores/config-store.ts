import { makeAutoObservable } from 'mobx';
import type { ProvidersMap, ProviderConfig, ModelConfig, NodeInfo } from '../../src/shared/ws-protocol';

export class ConfigStore {
  nodes: NodeInfo[] = [];

  constructor() {
    makeAutoObservable(this);
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

  providersEntriesForNode(name: string): [string, ProviderConfig][] {
    return Object.entries(this.providersForNode(name));
  }

  getModelsForNode(name: string, providerID: string): [string, ModelConfig][] {
    return Object.entries(this.providersForNode(name)[providerID]?.models ?? {});
  }

  getModelForNode(name: string, providerID: string, modelAlias: string): ModelConfig | undefined {
    return this.providersForNode(name)[providerID]?.models[modelAlias];
  }

  defaultModelForNode(name: string, providerID: string): string {
    const keys = Object.keys(this.providersForNode(name)[providerID]?.models ?? {});
    return keys[0] ?? 'sonnet';
  }

}
