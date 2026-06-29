import { getClientByNode } from '../init-state';

// Provider/model capabilities are reported by each orcd node over the protocol
// and cached on its OrcdClient. The BE derives a card's contextWindow and a
// project's default provider from the relevant node's advertised capabilities,
// rather than from any local config file.

export function contextWindowFor(nodeName: string, provider: string, modelAlias: string): number | undefined {
  const caps = getClientByNode(nodeName)?.capabilities;
  const p = caps?.providers.find((x) => x.id === provider);
  return p?.models.find((m) => m.alias === modelAlias)?.contextWindow;
}

export function defaultProviderFor(nodeName: string): string | undefined {
  return getClientByNode(nodeName)?.capabilities?.defaults.provider;
}
