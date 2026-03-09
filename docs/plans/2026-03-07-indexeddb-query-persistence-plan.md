# IndexedDB Query Cache Persistence — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist React Query cache to IndexedDB so the app loads instantly with cached data on reopen.

**Architecture:** Use `idb-keyval` for IndexedDB storage, `@tanstack/react-query-persist-client` to serialize/restore the QueryClient cache. All queries persist. No service worker changes.

**Tech Stack:** `idb-keyval`, `@tanstack/react-query-persist-client`, React Query 5

---

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install packages**

Run: `pnpm add idb-keyval @tanstack/react-query-persist-client`

**Step 2: Verify install**

Run: `pnpm ls idb-keyval @tanstack/react-query-persist-client`
Expected: Both packages listed with versions

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add idb-keyval and react-query-persist-client"
```

---

### Task 2: Create IndexedDB persister module

**Files:**
- Create: `app/lib/query-persist.ts`

**Step 1: Create the persister**

```typescript
import { createStore, get, set, del, entries } from 'idb-keyval';
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
  // Serialize to measure — same as what's stored
  const serialized = JSON.stringify(data);
  return new Blob([serialized]).size;
}

/** Clear all cached data */
export async function clearCache(): Promise<void> {
  await del(CACHE_KEY, store);
}
```

**Step 2: Verify file compiles**

Run: `pnpm build 2>&1 | tail -5`
Expected: No TypeScript errors related to query-persist.ts

**Step 3: Commit**

```bash
git add app/lib/query-persist.ts
git commit -m "feat: add IndexedDB persister for React Query cache"
```

---

### Task 3: Wire up PersistQueryClientProvider in root.tsx

**Files:**
- Modify: `app/root.tsx`

**Step 1: Update root.tsx**

Add import at top:
```typescript
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { persister } from '~/lib/query-persist';
```

Update the QueryClient to set `gcTime: Infinity`:
```typescript
const [queryClient] = useState(() => new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: Infinity,
    },
  },
}));
```

Replace `QueryClientProvider` with `PersistQueryClientProvider`:
```typescript
<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
  <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 24 }}>
    <Outlet />
  </PersistQueryClientProvider>
</TRPCProvider>
```

Remove the old `QueryClientProvider` import from `@tanstack/react-query` (keep the other imports like `QueryClient`).

**Step 2: Verify it builds**

Run: `pnpm build 2>&1 | tail -5`
Expected: Build succeeds

**Step 3: Manual test**

Run: `pnpm dev` (or restart service)
1. Open app, navigate to a card
2. Close tab, reopen — card data should appear instantly without flash
3. Check browser DevTools → Application → IndexedDB → `dispatcher-cache` → `query-cache` — should see a `tanstack-query` entry

**Step 4: Commit**

```bash
git add app/root.tsx
git commit -m "feat: persist React Query cache to IndexedDB"
```

---

### Task 4: Add loading state to CardDetail

**Files:**
- Modify: `app/components/CardDetail.tsx`

**Step 1: Update CardDetail to distinguish loading from not-found**

Change the query call on line 41 to also get `isLoading`:
```typescript
const { data: allCards, isLoading } = useQuery(trpc.cards.list.queryOptions());
```

Replace the `if (!card)` block (lines 142-148) with:
```typescript
if (!card) {
  return (
    <div className="flex flex-col h-full items-center justify-center text-muted-foreground">
      {isLoading ? 'Loading...' : 'Card not found'}
    </div>
  );
}
```

**Step 2: Verify it builds**

Run: `pnpm build 2>&1 | tail -5`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add app/components/CardDetail.tsx
git commit -m "fix: show loading state instead of 'not found' while cards query loads"
```

---

### Task 5: Add cache management UI to settings

**Files:**
- Modify: `app/routes/settings.projects.tsx`

**Step 1: Add storage section**

Add imports at top:
```typescript
import { useState, useEffect } from 'react';
import { getCacheSize, clearCache } from '~/lib/query-persist';
```

Note: `useState` is already imported — just add `useEffect` to the existing import.

Add a `CacheSection` component at the bottom of the file:

```typescript
function CacheSection() {
  const [size, setSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    getCacheSize().then(setSize);
  }, []);

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function handleClear() {
    setClearing(true);
    await clearCache();
    setSize(0);
    setClearing(false);
  }

  return (
    <Card>
      <CardContent className="flex items-center justify-between py-4">
        <div>
          <p className="text-sm font-medium">Local Cache</p>
          <p className="text-xs text-muted-foreground">
            {size === null ? 'Calculating...' : formatBytes(size)}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleClear}
          disabled={clearing || size === 0}
        >
          {clearing ? 'Clearing...' : 'Clear'}
        </Button>
      </CardContent>
    </Card>
  );
}
```

Add `<CacheSection />` inside the modal, after the projects table closing `)}` (after line 153), before the closing `</div>` tags:

```tsx
        {/* Cache management */}
        <div className="mt-6">
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Storage</h2>
          <CacheSection />
        </div>
```

**Step 2: Verify it builds**

Run: `pnpm build 2>&1 | tail -5`
Expected: Build succeeds

**Step 3: Manual test**

Open Settings → should see "Storage" section with cache size and Clear button.
Click Clear → size should go to 0 B.

**Step 4: Commit**

```bash
git add app/routes/settings.projects.tsx
git commit -m "feat: add cache size display and clear button to settings"
```
