import type { AckResponse, NodeProviderConfig, ProviderTestResult } from '../../../shared/ws-protocol';
import type { AppServer, AppSocket } from '../types';
import { getClientByNode } from '../../init-state';
import { nodesForClient } from '../../config/capabilities';
import type { OrcdClient } from '../../orcd-client';

/**
 * Provider config belongs to the node that runs from it, and editing it rewrites
 * the file that node boots from — so every path here is admin-only, and the
 * writes are relayed rather than performed by the backend.
 */
function nodeFor(socket: AppSocket, nodeName: string): OrcdClient {
  if (socket.data.identity.role !== 'admin') {
    throw new Error("Only an admin can change a node's providers.");
  }
  const client = getClientByNode(nodeName);
  if (!client) throw new Error(`Unknown node "${nodeName}" — check the node registry in orc.yaml.`);
  if (!client.isConnected()) throw new Error(`Node "${nodeName}" is not connected, so its config can't be read or written.`);
  return client;
}

export async function handleProvidersGet(
  socket: AppSocket,
  data: { nodeName: string },
  callback: (res: AckResponse<NodeProviderConfig>) => void,
): Promise<void> {
  try {
    const client = nodeFor(socket, data.nodeName);
    const snapshot = await client.getProviders();
    callback({ data: { nodeName: client.nodeName, ...snapshot } });
  } catch (err) {
    console.error('[ws] providers:get error:', err);
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleProvidersSave(
  socket: AppSocket,
  io: AppServer,
  data: {
    nodeName: string;
    providers: Record<string, Record<string, unknown>>;
    defaultProvider: string;
    defaultModel: string;
  },
  callback: (res: AckResponse) => void,
): Promise<void> {
  try {
    const client = nodeFor(socket, data.nodeName);
    await client.saveProviders({
      providers: data.providers,
      defaultProvider: data.defaultProvider,
      defaultModel: data.defaultModel,
    });
    // Every open board reads provider lists from its cached node capabilities, so
    // a save has to be pushed, not just acknowledged to the saver.
    io.emit('nodes:updated', nodesForClient());
    callback({});
  } catch (err) {
    console.error('[ws] providers:save error:', err);
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleProvidersTest(
  socket: AppSocket,
  data: { nodeName: string; baseUrl: string },
  callback: (res: AckResponse<ProviderTestResult>) => void,
): Promise<void> {
  try {
    const client = nodeFor(socket, data.nodeName);
    callback({ data: await client.testProvider(data.baseUrl) });
  } catch (err) {
    console.error('[ws] providers:test error:', err);
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
