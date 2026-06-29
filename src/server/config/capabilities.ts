import { getClientByNode, listNodeClients } from '../init-state';
import type { NodeInfo, ProviderConfig } from '../../shared/ws-protocol';

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

// Convert a node's advertised capabilities into the FE provider-config shape.
// modelID is unknown to the BE (orcd hides it), and the FE only needs
// alias/label/contextWindow for selection, so the alias doubles as modelID.
function providersFromNode(nodeName: string): Record<string, ProviderConfig> {
  const caps = getClientByNode(nodeName)?.capabilities;
  const providers: Record<string, ProviderConfig> = {};
  if (!caps) {
    console.log(`[capabilities] node ${nodeName} has no capabilities cached yet`);
    return providers;
  }
  for (const p of caps.providers) {
    providers[p.id] = {
      label: p.label,
      models: Object.fromEntries(p.models.map((m) => [m.alias, { label: m.label, modelID: m.alias, contextWindow: m.contextWindow }])),
    };
  }
  return providers;
}

/** Per-node info for the FE: connection state + advertised providers/models. */
export function nodesForClient(): NodeInfo[] {
  return listNodeClients().map((c) => {
    const caps = c.capabilities;
    return {
      name: c.nodeName,
      connected: c.isConnected(),
      providers: providersFromNode(c.nodeName),
      ...(caps ? { defaults: caps.defaults } : {}),
    };
  });
}

/** Union of all connected nodes' providers — back-compat for FE provider/model selectors. */
export function mergedProvidersForClient(): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = {};
  for (const c of listNodeClients()) {
    if (!c.isConnected()) continue;
    Object.assign(merged, providersFromNode(c.nodeName));
  }
  return merged;
}
