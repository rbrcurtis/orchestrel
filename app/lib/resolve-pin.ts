import type { Card } from '../../src/shared/ws-protocol';

/**
 * Resolve which card each pinned slot should display.
 *
 * Priority per project:
 *   1. Review cards — oldest createdAt first
 *   2. Running cards — newest updatedAt first
 *
 * Multiple slots pinned to the same project get distributed
 * across the ranked list (lower slot index = higher priority card).
 *
 * Cards already open in unpinned slots are excluded to avoid
 * showing the same card in both the hotseat and a pinned slot.
 *
 * Slot 0 is never pinned (hotseat) — pins[0] should always be null.
 *
 * @param cards - All cards from the card store
 * @param pins - columnPins array: projectId or null per slot
 * @param slots - columnSlots array: cardId or null per slot (used to exclude manually-opened cards)
 * @returns Array of cardId or null, same length as pins
 */
export function resolvePins(
  cards: Card[],
  pins: (number | null)[],
  slots: (number | null)[] = [],
): (number | null)[] {
  // Collect card IDs that are manually placed in unpinned slots
  const manualCardIds = new Set<number>();
  for (let i = 0; i < slots.length; i++) {
    if (pins[i] == null && slots[i] != null) {
      manualCardIds.add(slots[i]!);
    }
  }

  // Group pinned slot indices by projectId
  const projectSlots = new Map<number, number[]>();
  for (let i = 0; i < pins.length; i++) {
    const pid = pins[i];
    if (pid == null) continue;
    const s = projectSlots.get(pid);
    if (s) s.push(i);
    else projectSlots.set(pid, [i]);
  }

  const result: (number | null)[] = pins.map(() => null);

  for (const [projectId, slotIndices] of projectSlots) {
    // Build ranked card list for this project, excluding manually-opened cards
    const review = cards
      .filter((c) => c.projectId === projectId && c.column === 'review' && !manualCardIds.has(c.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const running = cards
      .filter((c) => c.projectId === projectId && c.column === 'running' && !manualCardIds.has(c.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const ranked = [...review, ...running];

    // Distribute across slots in slot-index order
    for (let i = 0; i < slotIndices.length; i++) {
      result[slotIndices[i]] = i < ranked.length ? ranked[i].id : null;
    }
  }

  return result;
}
