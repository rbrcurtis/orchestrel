import { get, set, del } from 'idb-keyval';

const VERSION = 'v1';
const INDEX_KEY = `conv:${VERSION}:index`;
const cardKey = (cardId: number) => `conv:${VERSION}:${cardId}`;

let budgetBytes = 100 * 1024 * 1024; // 100MB

// Test-only hook to shrink the budget so eviction is exercisable.
export function __setBudgetForTest(bytes: number): void {
  budgetBytes = bytes;
}

interface IndexRow {
  cardId: number;
  ts: number;
  bytes: number;
}

export async function readConversation(cardId: number): Promise<unknown[] | null> {
  const data = await get(cardKey(cardId));
  return Array.isArray(data) ? data : null;
}

export async function writeConversation(cardId: number, entries: unknown[]): Promise<void> {
  const json = JSON.stringify(entries);
  await set(cardKey(cardId), JSON.parse(json));
  await updateIndex(cardId, json.length);
}

async function updateIndex(cardId: number, bytes: number): Promise<void> {
  const index = ((await get(INDEX_KEY)) as IndexRow[] | undefined) ?? [];
  const rows = index.filter((r) => r.cardId !== cardId);
  rows.push({ cardId, ts: Date.now(), bytes });
  rows.sort((a, b) => a.ts - b.ts); // oldest first

  let total = rows.reduce((sum, r) => sum + r.bytes, 0);
  const kept: IndexRow[] = [];
  for (const row of rows) {
    // Never evict the card just written, even if it alone exceeds the budget.
    if (total > budgetBytes && row.cardId !== cardId) {
      await del(cardKey(row.cardId));
      total -= row.bytes;
      continue;
    }
    kept.push(row);
  }
  await set(INDEX_KEY, kept);
}
