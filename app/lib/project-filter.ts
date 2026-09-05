// app/lib/project-filter.ts
//
// Board project filter. Include and exclude sets are independent and coexist:
// cards are hidden when their project is excluded OR when an include filter is
// active and their project is not in it. A card of project B is therefore
// visible with project A excluded and B included ("!A AND B" → only B).
// An empty include set means "no include restriction"; both sets empty = no
// filter.

export type ProjectFilter = {
  /** Projects shown exclusively (empty = all shown, minus exclusions). */
  include: Set<number>;
  /** Projects hidden unconditionally. */
  exclude: Set<number>;
};

const FILTER_KEY = 'dispatcher-project-filter';

export function makeProjectFilter(): ProjectFilter {
  return { include: new Set<number>(), exclude: new Set<number>() };
}

export function projectFilterActive(f: ProjectFilter | null | undefined): boolean {
  return !!f && (f.include.size > 0 || f.exclude.size > 0);
}

/** True when a card in the given project must be hidden by the filter. */
export function isProjectHidden(f: ProjectFilter | null | undefined, projectId: number | null | undefined): boolean {
  if (!f || (f.include.size === 0 && f.exclude.size === 0)) return false;
  // Cards without a project: hidden while an include filter is active (they are
  // in no listed project), never hidden by exclusions alone.
  if (projectId == null) return f.include.size > 0;
  return f.exclude.has(projectId) || (f.include.size > 0 && !f.include.has(projectId));
}

/** Parse persisted JSON (legacy shapes migrate: bare arrays and the old
 * {exclude: boolean, ids} object both become include/exclude sets). */
export function parseProjectFilter(raw: string | null): ProjectFilter {
  if (!raw) return makeProjectFilter();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // Original format: bare id array = include-only filter.
      return { include: new Set(parsed.filter((n): n is number => typeof n === 'number')), exclude: new Set() };
    }
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      if ('include' in o && Array.isArray(o.include) && Array.isArray(o.exclude)) {
        return {
          include: new Set(o.include.filter((n): n is number => typeof n === 'number')),
          exclude: new Set(o.exclude.filter((n): n is number => typeof n === 'number')),
        };
      }
      if ('ids' in o && Array.isArray(o.ids)) {
        // Previous format: {exclude: boolean, ids: number[]}.
        const ids = new Set(o.ids.filter((n): n is number => typeof n === 'number'));
        return o.exclude === true
          ? { include: new Set(), exclude: ids }
          : { include: ids, exclude: new Set() };
      }
    }
  } catch {
    // fall through to empty filter
  }
  return makeProjectFilter();
}

export function serializeProjectFilter(f: ProjectFilter): string {
  return JSON.stringify({ include: [...f.include], exclude: [...f.exclude] });
}

export function readProjectFilter(): ProjectFilter {
  if (typeof window === 'undefined') return makeProjectFilter();
  return parseProjectFilter(localStorage.getItem(FILTER_KEY));
}

export function writeProjectFilter(f: ProjectFilter): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(FILTER_KEY, serializeProjectFilter(f));
}

/**
 * Toggle a project row. Each project cycles independently, unaffected by the
 * state of other projects:
 *   click 1 (none) → included (show only the included projects)
 *   click 2 (included) → excluded (never shown)
 *   click 3 (excluded) → none
 * So excluding one project and then clicking another leaves the first
 * exclusion in place and adds the second as included — the two coexist.
 */
export function toggleProjectFilter(prev: ProjectFilter, projectId: number): ProjectFilter {
  const include = new Set(prev.include);
  const exclude = new Set(prev.exclude);
  if (include.has(projectId)) {
    include.delete(projectId);
    exclude.add(projectId);
  } else if (exclude.has(projectId)) {
    exclude.delete(projectId);
  } else {
    include.add(projectId);
  }
  return { include, exclude };
}
