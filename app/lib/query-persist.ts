import { createStore, get, set, del } from 'idb-keyval';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';

const store = createStore('dispatcher-cache', 'query-cache');
const CACHE_KEY = 'tanstack-query';

export const persister: Persister = {
  persistClient: async (client: PersistedClient) => {
    await set(CACHE_KEY, client, store);
  },
  restoreClient: async () => {
    return await get<PersistedClient>(CACHE_KEY, store);
  },
  removeClient: async () => {
    await del(CACHE_KEY, store);
  },
};

/** Returns the approximate byte size of the persisted cache */
export async function getCacheSize(): Promise<number> {
  const data = await get(CACHE_KEY, store);
  if (!data) return 0;
  const serialized = JSON.stringify(data);
  return new Blob([serialized]).size;
}

/** Clear all cached data */
export async function clearCache(): Promise<void> {
  await del(CACHE_KEY, store);
}
