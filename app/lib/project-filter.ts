// app/lib/project-filter.ts
//
// Board project filter: "show only these projects" (include) or "show
// everything except these" (exclude). An empty `ids` set in either mode means
// no filtering. Exclude mode is reached by clicking the sole included project
// a second time (see toggleProjectFilter).

export type ProjectFilter = {
  /** true = hide the listed projects; false = show only the listed projects. */
  exclude: boolean;
  /** Project ids the filter applies to. Empty set = show everything. */
  ids: Set<number>;
};

const FILTER_KEY = 'dispatcher-project-filter';

export function makeProjectFilter(): ProjectFilter {
  return { exclude: false, ids: new Set<number>() };
}

export function projectFilterActive(f: ProjectFilter | null | undefined): boolean {
  return !!f && f.ids.size > 0;
}

/** True when a card in the given project must be hidden by the filter. */
export function isProjectHidden(f: ProjectFilter | null | undefined, projectId: number | null | undefined): boolean {
  if (!f || f.ids.size === 0) return false;
  // Cards without a project: hidden by include filters (they are in no listed
  // project), visible under exclude filters (they are in no hidden project).
  if (projectId == null) return !f.exclude;
  const listed = f.ids.has(projectId);
  return f.exclude ? listed : !listed;
}

/** Parse persisted JSON (legacy bare arrays mean include mode). */
export function parseProjectFilter(raw: string | null): ProjectFilter {
  if (!raw) return makeProjectFilter();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return { exclude: false, ids: new Set(parsed.filter((n): n is number => typeof n === 'number')) };
    }
    if (parsed && typeof parsed === 'object') {
      const { exclude, ids } = parsed as { exclude?: unknown; ids?: unknown };
      return {
        exclude: exclude === true,
        ids: new Set(Array.isArray(ids) ? ids.filter((n): n is number => typeof n === 'number') : []),
      };
    }
  } catch {
    // fall through to empty filter
  }
  return makeProjectFilter();
}

export function serializeProjectFilter(f: ProjectFilter): string {
  return JSON.stringify({ exclude: f.exclude, ids: [...f.ids] });
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
 * Toggle a project row. Clicks follow a tri-state cycle per single project:
 *   click 1 (nothing selected) → show only this project
 *   click 2 (sole included project) → show everything except it
 *   click 3 (sole excluded project) → show everything
 * With multiple projects selected, each click toggles membership in the active
 * set (include mode accumulates; exclude mode accumulates the hidden list).
 */
export function toggleProjectFilter(prev: ProjectFilter, projectId: number): ProjectFilter {
  const ids = new Set(prev.ids);
  if (ids.size === 0) {
    return { exclude: false, ids: new Set([projectId]) };
  }
  if (ids.has(projectId)) {
    if (ids.size > 1) {
      ids.delete(projectId);
      return { exclude: prev.exclude, ids };
    }
    // Sole listed project clicked again: include → exclude, exclude → clear.
    return prev.exclude ? makeProjectFilter() : { exclude: true, ids };
  }
  ids.add(projectId);
  return { exclude: prev.exclude, ids };
}
