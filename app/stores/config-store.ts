import { makeAutoObservable } from 'mobx';
import { DEFAULT_SENTINEL } from '../../src/shared/ws-protocol';
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

  nodeDefaultProvider(name: string): string | undefined {
    return this.nodeByName(name)?.defaults?.provider;
  }

  nodeDefaultModel(name: string): string | undefined {
    return this.nodeByName(name)?.defaults?.model;
  }

  nodeDefaultThinking(name: string): string | undefined {
    return this.nodeByName(name)?.defaults?.thinkingLevel;
  }

  /** Resolve a project's provider/model/thinking, replacing default sentinels with the node's orcd defaults. */
  resolveDefaults(
    name: string,
    providerID: string,
    model: string,
    thinkingLevel: string,
  ): { provider: string; model: string; thinkingLevel: string } {
    const thinking =
      thinkingLevel === DEFAULT_SENTINEL ? (this.nodeDefaultThinking(name) ?? 'high') : thinkingLevel;
    if (providerID !== DEFAULT_SENTINEL) {
      return {
        provider: providerID,
        model: model === DEFAULT_SENTINEL ? this.defaultModelForNode(name, providerID) : model,
        thinkingLevel: thinking,
      };
    }
    const provider = this.nodeDefaultProvider(name) ?? 'anthropic';
    return {
      provider,
      model: this.nodeDefaultModel(name) ?? this.defaultModelForNode(name, provider),
      thinkingLevel: thinking,
    };
  }

}
