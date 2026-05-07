// app/lib/use-slots.ts
import { useState, useEffect, useRef } from 'react';
import { resolvePinnedCards, type SlotState, type PinTarget } from './resolve-pin';
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
  // Already visible anywhere? Check manual slots, pinned slots (with resolver/override),
  // and empty slots that may have a virtual resolver result (hotseat).
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const displayed =
      slot.type === 'manual'
        ? slot.cardId
        : slot.type === 'pinned'
          ? (resolvedCards.get(i) ?? slot.cardId ?? null)
          : resolvedCards.get(i) ?? null;
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
  const slot = slots[index];
  if (slot.type === 'pinned') {
    next[index] = { type: 'pinned', projectId: slot.projectId };
  } else {
    next[index] = { type: 'empty' };
  }
  return next;
}

/** Fully remove a slot's pin and card — used by X buttons to dismiss a column. */
export function applyUnpinSlot(slots: SlotState[], index: number): SlotState[] {
  const next = [...slots];
  next[index] = { type: 'empty' };
  return next;
}

export function applyPinSlot(slots: SlotState[], index: number, projectId: PinTarget): SlotState[] {
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
  // Release hotseat to empty so the resolver picks the best card to show next.
  // The newly created card will be eligible if it's in review/running.
  const next = [...slots];
  next[0] = { type: 'empty' };
  return { slots: next, flashIndex: null };
}

/** Release the hotseat manual override — sets slot 0 to empty so the resolver takes over. */
export function applyReleaseHotseat(slots: SlotState[]): SlotState[] {
  if (slots[0]?.type === 'empty') return slots;
  const next = [...slots];
  next[0] = { type: 'empty' };
  return next;
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
  // Shrink: drop empty first, then manual, then pinned. Rightmost first within each group.
  // Slot 0 is never dropped.
  const toDrop = slots.length - newCount;
  const dropIndices = new Set<number>();
  const dropOrder: number[][] = [[], [], []]; // [empties, manuals, pinned]
  for (let i = slots.length - 1; i >= 1; i--) {
    const slot = slots[i];
    if (slot.type === 'empty') dropOrder[0].push(i);
    else if (slot.type === 'manual') dropOrder[1].push(i);
    else dropOrder[2].push(i);
  }
  for (const group of dropOrder) {
    for (const idx of group) {
      if (dropIndices.size >= toDrop) break;
      dropIndices.add(idx);
    }
    if (dropIndices.size >= toDrop) break;
  }
  return slots.filter((_, i) => !dropIndices.has(i));
}

// ─── Event-driven recalc (exported for testing) ─────────────────────────────

/**
 * Detect which slots should recalc based on card column transitions.
 *
 * Trigger: any card changes between review ↔ running.
 * Per-slot conditions (all must be true):
 *   1. Slot is pinned (including hotseat virtual pin at slot 0 when empty)
 *   2. Currently displayed card in the slot is running
 *   3. The changed card's project matches the slot's pin
 *   4. The slot is not focused (user not typing)
 *   5. A review card is available for this pin (avoids running→running swaps)
 *
 * Returns array of slot indices that should have sticky cleared.
 */
export function findSlotsToRecalc(
  prevColumns: Map<number, string>,
  cards: Card[],
  slots: SlotState[],
  currentResolved: Map<number, number>,
  focusedCardId: number | null,
): number[] {
  // Find cards that changed between review ↔ running
  const changed: Card[] = [];
  const cardById = new Map<number, Card>();
  for (const c of cards) {
    cardById.set(c.id, c);
    const prev = prevColumns.get(c.id);
    if (!prev) continue;
    if (
      (prev === 'review' && c.column === 'running') ||
      (prev === 'running' && c.column === 'review')
    ) {
      changed.push(c);
    }
  }

  if (changed.length === 0) return [];

  // Cards stored in slot state (manual + pinned overrides) OR currently assigned
  // by the resolver — excluded from the "available review" pool so condition 5
  // doesn't count a review card that's already occupying another slot.
  const usedCardIds = new Set<number>();
  for (const slot of slots) {
    if (slot.type === 'manual') usedCardIds.add(slot.cardId);
    else if (slot.type === 'pinned' && slot.cardId != null) usedCardIds.add(slot.cardId);
  }
  for (const [, cardId] of currentResolved) usedCardIds.add(cardId);

  const result = new Set<number>();

  for (const changedCard of changed) {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];

      // Condition 1: slot is pinned (including hotseat virtual pin)
      const isPinned = slot.type === 'pinned' || (i === 0 && slot.type === 'empty');
      if (!isPinned) continue;

      // Get the currently displayed card in this slot
      const displayedCardId =
        slot.type === 'pinned'
          ? (currentResolved.get(i) ?? slot.cardId ?? null)
          : currentResolved.get(i) ?? null;
      if (displayedCardId == null) continue;

      // Condition 4: input not focused in this slot
      if (displayedCardId === focusedCardId) continue;

      // Condition 2: currently displayed card is running
      const displayedCard = cardById.get(displayedCardId);
      if (!displayedCard || displayedCard.column !== 'running') continue;

      // Condition 3: changed card matches the pin's project
      const pinProjectId = slot.type === 'pinned' ? slot.projectId : 'all';
      if (pinProjectId !== 'all' && changedCard.projectId !== pinProjectId) continue;

      // Condition 5: a review card is available for this pin — skip if the
      // recalc would just swap one running card for another
      const hasReview = cards.some((c) =>
        c.column === 'review' &&
        c.projectId != null &&
        c.id !== displayedCardId &&
        !usedCardIds.has(c.id) &&
        (pinProjectId === 'all' || c.projectId === pinProjectId),
      );
      if (!hasReview) continue;

      result.add(i);
    }
  }

  return [...result];
}

// ─── useSlots hook ────────────────────────────────────────────────────────────

export type UseSlotsResult = {
  slots: SlotState[];
  resolvedCards: Map<number, number>;
  pinSlot: (index: number, projectId: PinTarget) => void;
  closeSlot: (index: number) => void;
  releaseHotseat: () => void;
  unpinSlot: (index: number) => void;
  selectCard: (cardId: number) => void;
  dropCard: (slotIndex: number, cardId: number, cardProjectId: number | null) => void;
  onCardCreated: (cardId: number, projectId: number | null) => void;
  flashSlot: number | null;
  clearFlash: () => void;
};

export function useSlots(
  columnCount: number,
  cards: Card[],
  projectFilter?: Set<number>,
  focusedCardId?: number | null,
): UseSlotsResult {
  const [slots, setSlots] = useState<SlotState[]>(() => {
    const migrated = migrateSlots();
    if (migrated) {
      writeLocalStorage(SLOTS_KEY, migrated);
      return migrated;
    }
    return readLocalStorage<SlotState[]>(SLOTS_KEY, [{ type: 'empty' }]);
  });

  const [flashSlot, setFlashSlot] = useState<number | null>(null);
  const [suppressedHotseatCardId, setSuppressedHotseatCardId] = useState<number | null>(null);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally no deps, runs every render
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

  // Flash detection + sticky resolver: track previous result
  const prevResolvedRef = useRef<Map<number, number>>(new Map());
  const prevCardColumnsRef = useRef<Map<number, string>>(new Map());

  // Compute which slots are locked (user is typing in them — don't swap the card)
  const lockedSlots = new Set<number>();
  if (focusedCardId != null) {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const displayed =
        slot.type === 'manual'
          ? slot.cardId
          : prevResolvedRef.current.get(i) ?? (slot.type === 'pinned' ? slot.cardId ?? null : null);
      if (displayed === focusedCardId) {
        lockedSlots.add(i);
        break;
      }
    }
  }

  // Compute resolver result fresh each render, passing previous for sticky behavior
  const resolvedCards = resolvePinnedCards(
    slots,
    cards,
    prevResolvedRef.current,
    projectFilter,
    lockedSlots.size > 0 ? lockedSlots : undefined,
    suppressedHotseatCardId,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally no deps, runs every render to detect flash
  useEffect(() => {
    for (const [i, cardId] of resolvedCards) {
      if (prevResolvedRef.current.get(i) !== cardId) {
        setFlashSlot(i);
        break; // one flash at a time
      }
    }
    prevResolvedRef.current = new Map(resolvedCards);
    if (suppressedHotseatCardId != null && resolvedCards.get(0) !== suppressedHotseatCardId) {
      setSuppressedHotseatCardId(null);
    }
  });

  // Event-driven recalc: clear sticky when cards transition between review ↔ running.
  // Must run AFTER flash effect so prevResolvedRef has the current render's values.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally no deps, runs every render
  useEffect(() => {
    const slotsToRecalc = findSlotsToRecalc(
      prevCardColumnsRef.current, cards, slots, resolvedCards, focusedCardId ?? null,
    );

    // Always update the column ref so next render can detect changes
    const nextCols = new Map<number, string>();
    for (const c of cards) nextCols.set(c.id, c.column);
    prevCardColumnsRef.current = nextCols;

    if (slotsToRecalc.length === 0) return;

    // Clear sticky + pinned overrides for affected slots
    const next = [...slots];
    let stateChanged = false;
    for (const i of slotsToRecalc) {
      prevResolvedRef.current.delete(i);
      const slot = next[i];
      if (slot.type === 'pinned' && slot.cardId != null) {
        next[i] = { type: 'pinned', projectId: slot.projectId };
        stateChanged = true;
      }
    }

    // Force re-render so resolver runs fresh for cleared slots
    if (stateChanged) {
      setSlots(next);
      writeLocalStorage(SLOTS_KEY, next);
    } else {
      setSlots((prev) => [...prev]);
    }
  });

  function pinSlot(index: number, projectId: PinTarget) {
    const next = applyPinSlot(slots, index, projectId);
    if (next === slots) return;
    setSlots(next);
    writeLocalStorage(SLOTS_KEY, next);
  }

  function closeSlot(index: number) {
    const next = applyCloseSlot(slots, index);
    setSlots(next);
    writeLocalStorage(SLOTS_KEY, next);
    setFlashSlot(index); // always flash to confirm the action was processed
  }

  function releaseHotseat() {
    const displayedHotseatCardId =
      slots[0]?.type === 'manual'
        ? slots[0].cardId
        : resolvedCards.get(0) ?? null;
    const next = applyReleaseHotseat(slots);
    if (next === slots) return;
    setSlots(next);
    writeLocalStorage(SLOTS_KEY, next);
    setSuppressedHotseatCardId(displayedHotseatCardId);
    setFlashSlot(0);
  }

  function unpinSlot(index: number) {
    const next = applyUnpinSlot(slots, index);
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
    releaseHotseat,
    unpinSlot,
    selectCard,
    dropCard,
    onCardCreated,
    flashSlot,
    clearFlash: () => setFlashSlot(null),
  };
}
