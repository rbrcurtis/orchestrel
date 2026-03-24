// app/lib/use-slots.ts
import { useState, useEffect, useRef } from 'react';
import { resolvePinnedCards, type SlotState } from './resolve-pin';
import type { Card } from '../../src/shared/ws-protocol';

// ─── localStorage helpers ────────────────────────────────────────────────────

const SLOTS_KEY = 'dispatcher-slots';
const OLD_SLOTS_KEY = 'dispatcher-column-slots';
const OLD_PINS_KEY = 'dispatcher-column-pins';

function readLocalStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalStorage<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ─── One-time migration from old two-array format ────────────────────────────

function migrateSlots(): SlotState[] | null {
  if (typeof window === 'undefined') return null;
  // If new key already exists, skip migration (prefer new format) but clean up old keys
  if (localStorage.getItem(SLOTS_KEY) != null) {
    localStorage.removeItem(OLD_SLOTS_KEY);
    localStorage.removeItem(OLD_PINS_KEY);
    return null;
  }
  const oldSlots = readLocalStorage<(number | null)[] | null>(OLD_SLOTS_KEY, null);
  const oldPins = readLocalStorage<(number | null)[] | null>(OLD_PINS_KEY, null);
  if (oldSlots == null && oldPins == null) return null;

  const len = Math.max(oldSlots?.length ?? 0, oldPins?.length ?? 0);
  const result: SlotState[] = [];
  for (let i = 0; i < len; i++) {
    const pinId = oldPins?.[i] ?? null;
    const cardId = oldSlots?.[i] ?? null;
    if (pinId != null) {
      result.push({ type: 'pinned', projectId: pinId });
    } else if (cardId != null) {
      result.push({ type: 'manual', cardId });
    } else {
      result.push({ type: 'empty' });
    }
  }

  localStorage.removeItem(OLD_SLOTS_KEY);
  localStorage.removeItem(OLD_PINS_KEY);
  return result;
}

// ─── Pure action functions (exported for testing) ────────────────────────────

export function applySelectCard(
  slots: SlotState[],
  cardId: number,
  cards: Card[],
  resolvedCards: Map<number, number>,
): { slots: SlotState[]; flashIndex: number | null } {
  // Already visible anywhere?
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const displayed =
      slot.type === 'manual'
        ? slot.cardId
        : slot.type === 'pinned'
          ? (resolvedCards.get(i) ?? slot.cardId ?? null)
          : null;
    if (displayed === cardId) return { slots, flashIndex: i };
  }

  const card = cards.find((c) => c.id === cardId);
  const projectId = card?.projectId ?? null;
  const next = [...slots];

  // Empty pinned slot for this project?
  if (projectId != null) {
    for (let i = 1; i < next.length; i++) {
      const slot = next[i];
      if (
        slot.type === 'pinned' &&
        slot.projectId === projectId &&
        resolvedCards.get(i) == null &&
        slot.cardId == null
      ) {
        next[i] = { type: 'pinned', projectId, cardId };
        return { slots: next, flashIndex: i };
      }
    }
  }

  // First empty slot at index >= 1, else slot 0
  const emptyIdx = next.findIndex((s, i) => i >= 1 && s.type === 'empty');
  const targetIdx = emptyIdx >= 0 ? emptyIdx : 0;
  next[targetIdx] = { type: 'manual', cardId };
  return { slots: next, flashIndex: targetIdx };
}

export function applyDropCard(
  slots: SlotState[],
  slotIndex: number,
  cardId: number,
  cardProjectId: number | null,
): { slots: SlotState[]; flashIndex: number | null } {
  const next = [...slots];

  // Remove card from any other slot where it is stored in state
  for (let i = 0; i < next.length; i++) {
    if (i === slotIndex) continue;
    const slot = next[i];
    if (slot.type === 'manual' && slot.cardId === cardId) {
      next[i] = { type: 'empty' };
    } else if (slot.type === 'pinned' && slot.cardId === cardId) {
      // Clear override but preserve pin so the resolver can refill it
      next[i] = { type: 'pinned', projectId: slot.projectId };
    }
  }

  // Place card in target slot
  const target = slots[slotIndex];
  if (target.type === 'pinned' && cardProjectId === target.projectId) {
    next[slotIndex] = { type: 'pinned', projectId: target.projectId, cardId };
  } else {
    next[slotIndex] = { type: 'manual', cardId };
  }

  return { slots: next, flashIndex: slotIndex };
}

export function applyCloseSlot(slots: SlotState[], index: number): SlotState[] {
  const next = [...slots];
  next[index] = { type: 'empty' };
  return next;
}

export function applyPinSlot(slots: SlotState[], index: number, projectId: number): SlotState[] {
  if (index === 0) return slots;
  const next = [...slots];
  next[index] = { type: 'pinned', projectId };
  return next;
}

export function applyOnCardCreated(
  slots: SlotState[],
  cardId: number,
  projectId: number | null,
): { slots: SlotState[]; flashIndex: number | null } {
  if (projectId != null && slots.some((s) => s.type === 'pinned' && s.projectId === projectId)) {
    return { slots, flashIndex: null };
  }
  const next = [...slots];
  next[0] = { type: 'manual', cardId };
  return { slots: next, flashIndex: 0 };
}

export function applyEviction(slots: SlotState[], existingCardIds: Set<number>): SlotState[] {
  let changed = false;
  const next = slots.map((slot) => {
    if (slot.type === 'manual' && !existingCardIds.has(slot.cardId)) {
      changed = true;
      return { type: 'empty' as const };
    }
    if (slot.type === 'pinned' && slot.cardId != null && !existingCardIds.has(slot.cardId)) {
      changed = true;
      return { type: 'pinned' as const, projectId: slot.projectId };
    }
    return slot;
  });
  return changed ? next : slots;
}

export function applyColumnCountChange(slots: SlotState[], newCount: number): SlotState[] {
  if (slots.length === newCount) return slots;
  if (slots.length < newCount) {
    const padding: SlotState[] = Array(newCount - slots.length).fill({ type: 'empty' as const });
    return [...slots, ...padding];
  }
  return slots.slice(0, newCount);
}

// ─── useSlots hook ────────────────────────────────────────────────────────────

export type UseSlotsResult = {
  slots: SlotState[];
  resolvedCards: Map<number, number>;
  pinSlot: (index: number, projectId: number) => void;
  closeSlot: (index: number) => void;
  selectCard: (cardId: number) => void;
  dropCard: (slotIndex: number, cardId: number, cardProjectId: number | null) => void;
  onCardCreated: (cardId: number, projectId: number | null) => void;
  flashSlot: number | null;
  clearFlash: () => void;
};

export function useSlots(columnCount: number, cards: Card[]): UseSlotsResult {
  const [slots, setSlots] = useState<SlotState[]>(() => {
    const migrated = migrateSlots();
    if (migrated) {
      writeLocalStorage(SLOTS_KEY, migrated);
      return migrated;
    }
    return readLocalStorage<SlotState[]>(SLOTS_KEY, [{ type: 'empty' }]);
  });

  const [flashSlot, setFlashSlot] = useState<number | null>(null);
  const cardsSeenRef = useRef(cards.length > 0);
  if (cards.length > 0) cardsSeenRef.current = true;

  // Sync array length with columnCount
  useEffect(() => {
    setSlots((prev) => {
      const next = applyColumnCountChange(prev, columnCount);
      if (next === prev) return prev;
      writeLocalStorage(SLOTS_KEY, next);
      return next;
    });
  }, [columnCount]);

  // Eviction — runs every render (hook lives inside observer(), MobX drives re-renders)
  // Skip when cards haven't loaded yet to avoid wiping stored slots on first render
  useEffect(() => {
    if (!cardsSeenRef.current) return;
    const existingIds = new Set(cards.map((c) => c.id));
    setSlots((prev) => {
      const next = applyEviction(prev, existingIds);
      if (next === prev) return prev;
      writeLocalStorage(SLOTS_KEY, next);
      return next;
    });
  });

  // Compute resolver result fresh each render
  const resolvedCards = resolvePinnedCards(slots, cards);

  // Flash detection for resolver-driven card appearances
  const prevResolvedRef = useRef<Map<number, number>>(new Map());
  useEffect(() => {
    for (const [i, cardId] of resolvedCards) {
      if (prevResolvedRef.current.get(i) !== cardId) {
        setFlashSlot(i);
        break; // one flash at a time
      }
    }
    prevResolvedRef.current = resolvedCards;
  });

  function pinSlot(index: number, projectId: number) {
    const next = applyPinSlot(slots, index, projectId);
    if (next === slots) return;
    setSlots(next);
    writeLocalStorage(SLOTS_KEY, next);
  }

  function closeSlot(index: number) {
    const next = applyCloseSlot(slots, index);
    setSlots(next);
    writeLocalStorage(SLOTS_KEY, next);
  }

  function selectCard(cardId: number) {
    // resolvedCards is already computed above in the hook body — reuse it
    const { slots: next, flashIndex } = applySelectCard(slots, cardId, cards, resolvedCards);
    if (next !== slots) {
      setSlots(next);
      writeLocalStorage(SLOTS_KEY, next);
    }
    if (flashIndex != null) setFlashSlot(flashIndex);
  }

  function dropCard(slotIndex: number, cardId: number, cardProjectId: number | null) {
    const { slots: next, flashIndex } = applyDropCard(slots, slotIndex, cardId, cardProjectId);
    setSlots(next);
    writeLocalStorage(SLOTS_KEY, next);
    if (flashIndex != null) setFlashSlot(flashIndex);
  }

  function onCardCreated(cardId: number, projectId: number | null) {
    const { slots: next, flashIndex } = applyOnCardCreated(slots, cardId, projectId);
    if (next === slots) return;
    setSlots(next);
    writeLocalStorage(SLOTS_KEY, next);
    if (flashIndex != null) setFlashSlot(flashIndex);
  }

  return {
    slots,
    resolvedCards,
    pinSlot,
    closeSlot,
    selectCard,
    dropCard,
    onCardCreated,
    flashSlot,
    clearFlash: () => setFlashSlot(null),
  };
}
