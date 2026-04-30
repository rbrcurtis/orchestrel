import type { Card } from '../../src/shared/ws-protocol';

export type PinTarget = number | 'all';

export type SlotState =
  | { type: 'pinned'; projectId: PinTarget; cardId?: number }
  | { type: 'manual'; cardId: number }
  | { type: 'empty' };

/** Rank eligible cards: review (oldest updatedAt) → running (oldest updatedAt). */
function rankCards(eligible: Card[]): Card[] {
  const review = eligible
    .filter((c) => c.column === 'review')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  const running = eligible
    .filter((c) => c.column === 'running')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  return [...review, ...running];
}

/**
 * Resolve which card each pinned slot should display.
 *
 * Returns Map<slotIndex, cardId> for every pinned slot with a qualifying card.
 * Pinned slots with no qualifying card are absent from the map.
 *
 * Cards already visible in any slot (manual or pinned override) are excluded.
 *
 * Strict sticky: if a slot was previously displaying a card that is still
 * eligible (same project, still review/running, not excluded), it stays —
 * no exceptions. New cards only fill unfilled slots from the ranked pool.
 *
 * Locked slots: slots in the lockedSlots set keep their previous card
 * unconditionally (as long as the card still exists). Used to protect slots
 * where the user is actively typing.
 *
 * Slot 0 "hotseat" virtual pin: when slot 0 is empty, it acts as a virtual
 * "all projects" pin. Real pinned slots (per-project and "all") get priority;
 * the hotseat gets whatever's left. An optional projectFilter restricts which
 * projects both the hotseat and "all" pins consider (per-project pins are
 * unaffected by the filter — pinning a specific project is itself a filter).
 *
 * Priority per project:
 *   1. Review cards — oldest updatedAt first
 *   2. Running cards — oldest updatedAt first
 */
export function resolvePinnedCards(
  slots: SlotState[],
  cards: Card[],
  currentDisplayed: Map<number, number> = new Map(),
  projectFilter?: Set<number>,
  lockedSlots?: Set<number>,
): Map<number, number> {
  // Build exclusion set: cards already stored in any slot
  const usedCardIds = new Set<number>();
  for (const slot of slots) {
    if (slot.type === 'manual') usedCardIds.add(slot.cardId);
    else if (slot.type === 'pinned' && slot.cardId != null) usedCardIds.add(slot.cardId);
  }

  // Index cards by id for fast lookup
  const cardById = new Map<number, Card>();
  for (const c of cards) cardById.set(c.id, c);

  // --- Lock pass: locked slots keep their previous card unconditionally ---
  const result = new Map<number, number>();
  if (lockedSlots) {
    for (const idx of lockedSlots) {
      const prevCardId = currentDisplayed.get(idx);
      if (prevCardId != null && cardById.has(prevCardId)) {
        result.set(idx, prevCardId);
        usedCardIds.add(prevCardId);
      }
    }
  }

  // Group pinned slot indices by projectId (number keys) and collect "all" slots separately
  const projectSlots = new Map<number, number[]>();
  const allSlotIndices: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    if (result.has(i)) continue; // skip locked slots
    const slot = slots[i];
    if (slot.type !== 'pinned') continue;
    if (slot.projectId === 'all') {
      allSlotIndices.push(i);
      continue;
    }
    const existing = projectSlots.get(slot.projectId);
    if (existing) existing.push(i);
    else projectSlots.set(slot.projectId, [i]);
  }

  // --- Per-project resolution ---
  for (const [projectId, slotIndices] of projectSlots) {
    const eligible = cards.filter(
      (c) => c.projectId === projectId && (c.column === 'review' || c.column === 'running') && !usedCardIds.has(c.id),
    );

    const stickyCardIds = new Set<number>();
    const unfilledSlots: number[] = [];
    for (const idx of slotIndices) {
      const prevCardId = currentDisplayed.get(idx);
      if (prevCardId != null) {
        const card = cardById.get(prevCardId);
        if (
          card &&
          card.projectId === projectId &&
          (card.column === 'review' || card.column === 'running') &&
          !usedCardIds.has(card.id)
        ) {
          result.set(idx, prevCardId);
          stickyCardIds.add(prevCardId);
          continue;
        }
      }
      unfilledSlots.push(idx);
    }

    const ranked = rankCards(eligible.filter((c) => !stickyCardIds.has(c.id)));

    for (let i = 0; i < unfilledSlots.length; i++) {
      if (i < ranked.length) result.set(unfilledSlots[i], ranked[i].id);
    }
  }

  // --- "All" slots: collect cards not already claimed ---
  if (allSlotIndices.length > 0) {
    const claimedByProjectPins = new Set(result.values());
    const hasFilter = !!projectFilter && projectFilter.size > 0;
    const passesFilter = (projectId: number) => !hasFilter || projectFilter!.has(projectId);
    const eligible = cards.filter(
      (c) =>
        c.projectId != null &&
        passesFilter(c.projectId) &&
        (c.column === 'review' || c.column === 'running') &&
        !usedCardIds.has(c.id) &&
        !claimedByProjectPins.has(c.id),
    );

    const stickyCardIds = new Set<number>();
    const unfilledSlots: number[] = [];
    for (const idx of allSlotIndices) {
      const prevCardId = currentDisplayed.get(idx);
      if (prevCardId != null) {
        const card = cardById.get(prevCardId);
        if (
          card &&
          card.projectId != null &&
          passesFilter(card.projectId) &&
          (card.column === 'review' || card.column === 'running') &&
          !usedCardIds.has(card.id) &&
          !claimedByProjectPins.has(card.id)
        ) {
          result.set(idx, prevCardId);
          stickyCardIds.add(prevCardId);
          continue;
        }
      }
      unfilledSlots.push(idx);
    }

    const ranked = rankCards(eligible.filter((c) => !stickyCardIds.has(c.id)));

    for (let i = 0; i < unfilledSlots.length; i++) {
      if (i < ranked.length) result.set(unfilledSlots[i], ranked[i].id);
    }
  }

  // --- Hotseat virtual pin: slot 0 when empty acts like an "all" pin ---
  if (slots.length > 0 && slots[0].type === 'empty' && !result.has(0)) {
    const claimedByPins = new Set(result.values());
    let eligible = cards.filter(
      (c) =>
        c.projectId != null &&
        (c.column === 'review' || c.column === 'running') &&
        !usedCardIds.has(c.id) &&
        !claimedByPins.has(c.id),
    );

    // Apply project filter to hotseat only (real pins are unaffected)
    if (projectFilter && projectFilter.size > 0) {
      eligible = eligible.filter((c) => projectFilter.has(c.projectId!));
    }

    // Sticky behavior for hotseat
    const prevCardId = currentDisplayed.get(0);
    if (prevCardId != null) {
      const card = cardById.get(prevCardId);
      if (
        card &&
        card.projectId != null &&
        (card.column === 'review' || card.column === 'running') &&
        !usedCardIds.has(card.id) &&
        !claimedByPins.has(card.id) &&
        (!projectFilter || projectFilter.size === 0 || projectFilter.has(card.projectId))
      ) {
        result.set(0, prevCardId);
      } else {
        const ranked = rankCards(eligible);
        if (ranked.length > 0) result.set(0, ranked[0].id);
      }
    } else {
      const ranked = rankCards(eligible);
      if (ranked.length > 0) result.set(0, ranked[0].id);
    }
  }

  return result;
}
