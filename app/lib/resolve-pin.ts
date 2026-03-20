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
 * Slot 0 is never pinned (hotseat) — pins[0] should always be null.
 *
 * @param cards - All cards from the card store
 * @param pins - columnPins array: projectId or null per slot
 * @returns Array of cardId or null, same length as pins
 */
export function resolvePins(cards: Card[], pins: (number | null)[]): (number | null)[] {
  // Group pinned slot indices by projectId
  const projectSlots = new Map<number, number[]>();
  for (let i = 0; i < pins.length; i++) {
    const pid = pins[i];
    if (pid == null) continue;
    const slots = projectSlots.get(pid);
    if (slots) slots.push(i);
    else projectSlots.set(pid, [i]);
  }

  const result: (number | null)[] = pins.map(() => null);

  for (const [projectId, slotIndices] of projectSlots) {
    // Build ranked card list for this project
    const review = cards
      .filter((c) => c.projectId === projectId && c.column === 'review')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const running = cards
      .filter((c) => c.projectId === projectId && c.column === 'running')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const ranked = [...review, ...running];

    // Distribute across slots in slot-index order
    for (let i = 0; i < slotIndices.length; i++) {
      result[slotIndices[i]] = i < ranked.length ? ranked[i].id : null;
    }
  }

  return result;
}
