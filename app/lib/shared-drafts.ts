import { Capacitor, registerPlugin } from '@capacitor/core';
import { createStore, del, get, keys, set, type UseStore } from 'idb-keyval';
import { z } from 'zod';

export type SharedDraftDestination = 'card' | 'chat';
export type SharedDraft = {
  id: string;
  destination: SharedDraftDestination;
  text: string;
  files: File[];
  errors: string[];
  createdAt: string;
};

type NativeFile = { id: string; name: string; mimeType: string; url: string; size: number };
type NativeDraft = {
  version: 1;
  id: string;
  createdAt: string;
  text: string;
  files: NativeFile[];
  errors: string[];
};

export interface SharedDraftNative {
  list(): Promise<{ drafts: Array<{ id: string; createdAt: string }> }>;
  read(opts: { id: string }): Promise<NativeDraft>;
  acknowledge(opts: { id: string }): Promise<void>;
  discard(opts: { id: string }): Promise<void>;
  addListener?(event: 'sharedDraftReceived', cb: (data: { id: string }) => void): Promise<{ remove(): Promise<void> }>;
}

const plugin = registerPlugin<SharedDraftNative>('SharedDraft');
const defaultStore = createStore('orchestrel-shared-drafts', 'drafts');
const summarySchema = z.object({ drafts: z.array(z.object({ id: z.string(), createdAt: z.string() })) });
const nativeDraftSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  createdAt: z.string(),
  text: z.string(),
  files: z.array(z.object({ id: z.string(), name: z.string(), mimeType: z.string(), url: z.string(), size: z.number() })),
  errors: z.array(z.string()),
});

function key(destination: SharedDraftDestination, id: string) {
  return `${destination}:${id}`;
}

export async function listDrafts(destination: SharedDraftDestination, store: UseStore = defaultStore): Promise<SharedDraft[]> {
  const all = await keys(store);
  const drafts: SharedDraft[] = [];
  for (const item of all) {
    if (typeof item !== 'string' || !item.startsWith(`${destination}:`)) continue;
    const draft = await get<SharedDraft>(item, store);
    if (draft) drafts.push(draft);
  }
  return drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function importSharedDrafts(
  destination: SharedDraftDestination,
  deps: { native?: SharedDraftNative; store?: UseStore } = {},
): Promise<SharedDraft[]> {
  if (!deps.native && !Capacitor.isNativePlatform()) return [];
  const native = deps.native ?? plugin;
  const store = deps.store ?? defaultStore;
  const summaries = summarySchema.parse(await native.list()).drafts;

  for (const summary of summaries) {
    const draftKey = key(destination, summary.id);
    if (await get(draftKey, store)) {
      await native.acknowledge({ id: summary.id });
      continue;
    }

    const source = nativeDraftSchema.parse(await native.read({ id: summary.id }));
    const files: File[] = [];
    const errors = [...source.errors];
    for (const item of source.files) {
      try {
        const res = await fetch(Capacitor.convertFileSrc(item.url));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        files.push(new File([await res.blob()], item.name, { type: item.mimeType }));
      } catch (err) {
        errors.push(`Could not import ${item.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const draft: SharedDraft = { id: source.id, destination, text: source.text, files, errors, createdAt: source.createdAt };
    await set(draftKey, draft, store);
    await native.acknowledge({ id: source.id });
  }

  return listDrafts(destination, store);
}

export async function saveDraft(draft: SharedDraft, store: UseStore = defaultStore): Promise<void> {
  await set(key(draft.destination, draft.id), draft, store);
}

export async function discardDraft(draft: Pick<SharedDraft, 'destination' | 'id'>, store: UseStore = defaultStore): Promise<void> {
  await del(key(draft.destination, draft.id), store);
}

export async function subscribeToNativeShares(callback: () => void): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};
  const listener = await plugin.addListener?.('sharedDraftReceived', callback);
  return () => { void listener?.remove(); };
}
