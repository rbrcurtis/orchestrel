import { createContext, useContext } from 'react';
import type { RootStore } from './root-store';

const StoreContext = createContext<RootStore | null>(null);

export function StoreProvider({ store, children }: { store: RootStore; children: React.ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): RootStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used within StoreProvider');
  return store;
}

export function useCardStore() {
  return useStore().cards;
}
export function useConfigStore() {
  return useStore().config;
}
export function useProjectStore() {
  return useStore().projects;
}
export function useSessionStore() {
  return useStore().sessions;
}
