// Cache confirmed transcript pages, never live deltas. Page data and its revision
// are committed together so interrupted writes cannot advertise missing records.
// Keys include the authenticated account, node, and effective session.
export interface TranscriptCacheScope {
  userId: number;
  nodeName: string;
  sessionId: string;
}

export interface TranscriptCachePage {
  anchor: string;
  revision: string;
  records: unknown[];
}

interface StoredPage extends TranscriptCachePage {
  id: string;
  scope: string;
  bytes: number;
  accessed: number;
}

const DB_NAME = 'orchestrel-transcripts-v3';
const BUDGET = 100 * 1024 * 1024;
let opening: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const pages = request.result.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('scope', 'scope');
      pages.createIndex('accessed', 'accessed');
      request.result.createObjectStore('metadata', { keyPath: 'id' });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Transcript cache upgrade blocked'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
  }).catch((err: unknown) => { opening = undefined; throw err; });
  return opening;
}

function scopeKey(scope: TranscriptCacheScope): string {
  return JSON.stringify([scope.userId, scope.nodeName, scope.sessionId]);
}

export async function readTranscriptPage(scope: TranscriptCacheScope, anchor: string): Promise<TranscriptCachePage | undefined> {
  try {
    const db = await database();
    return await new Promise<TranscriptCachePage | undefined>((resolve, reject) => {
      const tx = db.transaction(['pages', 'metadata'], 'readwrite');
      const store = tx.objectStore('pages');
      const request = store.get(JSON.stringify([scopeKey(scope), anchor]));
      let result: TranscriptCachePage | undefined;
      request.onsuccess = () => {
        const page = request.result as StoredPage | undefined;
        if (!page) return;
        if (!Array.isArray(page.records) || typeof page.revision !== 'string') {
          store.delete(page.id);
          return;
        }
        const accessed = Date.now();
        store.put({ ...page, accessed });
        tx.objectStore('metadata').put({ id: page.id, scope: page.scope, bytes: page.bytes, accessed });
        result = { anchor: page.anchor, revision: page.revision, records: page.records };
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[transcript-cache] read failed', err);
    return undefined;
  }
}

// expectedRevision is the version the caller read. A stale response from another
// tab cannot overwrite a newer page. null means the page must not exist yet.
export async function writeTranscriptPage(
  scope: TranscriptCacheScope,
  page: TranscriptCachePage,
  expectedRevision: string | null,
): Promise<boolean> {
  try {
    const key = scopeKey(scope);
    const record: StoredPage = {
      ...page,
      id: JSON.stringify([key, page.anchor]),
      scope: key,
      bytes: 0,
      accessed: Date.now(),
    };
    record.bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength + 32;
    if (record.bytes > BUDGET) {
      console.debug('[transcript-cache] page exceeds cache budget');
      return false;
    }
    const db = await database();
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(['pages', 'metadata'], 'readwrite');
      const store = tx.objectStore('pages');
      const request = store.get(record.id);
      let accepted = false;
      request.onsuccess = () => {
        const previous = request.result as StoredPage | undefined;
        if ((previous?.revision ?? null) !== expectedRevision) return;
        // Scan metadata with a cursor instead of loading all cached transcripts.
        let total = record.bytes;
        const sizes: Array<{ id: string; scope: string; bytes: number; accessed: number }> = [];
        const cursor = tx.objectStore('metadata').openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (current) {
            const item = current.value as StoredPage;
            if (item.id !== record.id) {
              total += item.bytes;
              sizes.push({ id: item.id, scope: item.scope, bytes: item.bytes, accessed: item.accessed });
            }
            current.continue();
            return;
          }
          const access = new Map<string, number>();
          for (const item of sizes) access.set(item.scope, Math.max(access.get(item.scope) ?? 0, item.accessed));
          sizes.sort((a, b) => {
            if (a.scope === key && b.scope !== key) return 1;
            if (b.scope === key && a.scope !== key) return -1;
            return (access.get(a.scope)! - access.get(b.scope)!) || a.accessed - b.accessed;
          });
          for (const item of sizes) {
            if (total <= BUDGET) break;
            store.delete(item.id);
            tx.objectStore('metadata').delete(item.id);
            total -= item.bytes;
          }
          store.put(record);
          tx.objectStore('metadata').put({ id: record.id, scope: record.scope, bytes: record.bytes, accessed: record.accessed });
          accepted = true;
        };
      };
      tx.oncomplete = () => resolve(accepted);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[transcript-cache] write failed', err);
    return false;
  }
}

export async function deleteTranscriptCache(scope: TranscriptCacheScope): Promise<void> {
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['pages', 'metadata'], 'readwrite');
      const cursor = tx.objectStore('pages').index('scope').openKeyCursor(IDBKeyRange.only(scopeKey(scope)));
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        tx.objectStore('pages').delete(item.primaryKey);
        tx.objectStore('metadata').delete(item.primaryKey);
        item.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[transcript-cache] delete failed', err);
  }
}
