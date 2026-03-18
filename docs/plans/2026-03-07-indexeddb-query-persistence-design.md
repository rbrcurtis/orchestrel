# IndexedDB Query Cache Persistence

## Problem

When reopening the Orchestrel PWA on mobile, the React Query cache is empty. This causes:
- "Card not found" flash when a card URL is persisted (`?card=123`) but `allCards` hasn't loaded yet
- Blank chat history while session JSONL re-fetches from the server
- Frequent re-render flashes on mobile due to `refetchOnWindowFocus` firing on every app switch

## Solution

Persist the entire React Query cache to IndexedDB using `idb-keyval`. On app open, cached data renders instantly while queries silently revalidate in the background.

## Dependencies

- `idb-keyval` (~600B) — minimal IndexedDB key-value wrapper

## Changes

### New: `app/lib/query-persist.ts`

IndexedDB-backed persister for `@tanstack/react-query-persist-client`:
- `persister` — async persister using `idb-keyval` `get`/`set`/`del`
- `getCacheSize()` — returns byte size of the stored cache blob
- `clearCache()` — wipes the IndexedDB store

### Modified: `app/root.tsx`

- Replace `QueryClientProvider` with `PersistQueryClientProvider` from `@tanstack/react-query-persist-client`
- Set `gcTime: Infinity` on QueryClient so entries survive long enough for the persister to restore them
- Wire up the persister with a reasonable `maxAge` (24h)

### Modified: `app/components/CardDetail.tsx`

- When `allCards` query is still loading (no cache, no network response yet), show a loading indicator instead of "Card not found"
- "Card not found" only shown when the query has resolved and the card ID doesn't exist

### Modified: `app/routes/settings.projects.tsx`

- Add "Storage" section below existing project management UI
- Display current cache size (formatted as KB/MB)
- "Clear Cache" button that calls `clearCache()` and reloads the page

## Behavior

- All React Query data persisted: cards, projects, session history, claude status
- On app open: show cached data immediately, revalidate in background
- No explicit cache invalidation — React Query's normal stale/refetch handles freshness
- Cache auto-expires after 24h via `maxAge`
- No service worker changes needed
