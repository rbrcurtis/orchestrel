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

// Live-derived context window for a card. The persisted card.context_window is a
// cache that silently drifts: contextWindowFor() returns undefined when the node
// is disconnected or hasn't pushed capabilities yet (e.g. a card created during a
// BE restart / node reconnect), so the DB column keeps its 200k schema default
// regardless of model. Always prefer the node's live advertised window; fall back
// to the (possibly stale) persisted value, then a hard 200k floor. This makes the
// window self-heal the moment the node's capabilities are available.
export function windowForCard(card: { nodeName: string; provider: string; model: string; contextWindow?: number }): number {
  const live = contextWindowFor(card.nodeName, card.provider, card.model);
  const persisted = card.contextWindow && card.contextWindow > 0 ? card.contextWindow : 0;
  return (live && live > 0 ? live : 0) || persisted || 200_000;
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
