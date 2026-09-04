// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isProjectHidden,
  makeProjectFilter,
  parseProjectFilter,
  readProjectFilter,
  serializeProjectFilter,
  toggleProjectFilter,
  writeProjectFilter,
} from './project-filter';

beforeEach(() => {
  localStorage.clear();
});

describe('toggleProjectFilter — click cycle for a single project', () => {
  it('first click shows only that project (include)', () => {
    const next = toggleProjectFilter(makeProjectFilter(), 7);
    expect(next.exclude).toBe(false);
    expect([...next.ids]).toEqual([7]);
  });

  it('second click on the sole included project excludes it', () => {
    const next = toggleProjectFilter({ exclude: false, ids: new Set([7]) }, 7);
    expect(next.exclude).toBe(true);
    expect([...next.ids]).toEqual([7]);
  });

  it('third click on the sole excluded project clears the filter', () => {
    const next = toggleProjectFilter({ exclude: true, ids: new Set([7]) }, 7);
    expect(next.ids.size).toBe(0);
  });
});

describe('toggleProjectFilter — multi-project behavior', () => {
  it('clicking a different project adds it to the include set', () => {
    const next = toggleProjectFilter({ exclude: false, ids: new Set([7]) }, 9);
    expect(next.exclude).toBe(false);
    expect([...next.ids].sort()).toEqual([7, 9]);
  });

  it('removing one project from a multi-include keeps include mode', () => {
    const next = toggleProjectFilter({ exclude: false, ids: new Set([7, 9]) }, 7);
    expect(next.exclude).toBe(false);
    expect([...next.ids]).toEqual([9]);
  });

  it('exclude mode accumulates more excluded projects', () => {
    const next = toggleProjectFilter({ exclude: true, ids: new Set([7]) }, 9);
    expect(next.exclude).toBe(true);
    expect([...next.ids].sort()).toEqual([7, 9]);
  });

  it('removing one project from a multi-exclude keeps exclude mode', () => {
    const next = toggleProjectFilter({ exclude: true, ids: new Set([7, 9]) }, 7);
    expect(next.exclude).toBe(true);
    expect([...next.ids]).toEqual([9]);
  });
});

describe('isProjectHidden', () => {
  it('shows everything when the filter is inactive', () => {
    expect(isProjectHidden(makeProjectFilter(), 7)).toBe(false);
    expect(isProjectHidden(makeProjectFilter(), null)).toBe(false);
  });

  it('include filter hides projects outside the set', () => {
    const f = { exclude: false, ids: new Set([7]) };
    expect(isProjectHidden(f, 7)).toBe(false);
    expect(isProjectHidden(f, 8)).toBe(true);
  });

  it('exclude filter hides only the listed projects', () => {
    const f = { exclude: true, ids: new Set([7]) };
    expect(isProjectHidden(f, 7)).toBe(true);
    expect(isProjectHidden(f, 8)).toBe(false);
  });

  it('cards without a project follow include (hidden) / exclude (shown) semantics', () => {
    const include = { exclude: false, ids: new Set([7]) };
    const exclude = { exclude: true, ids: new Set([7]) };
    expect(isProjectHidden(include, null)).toBe(true);
    expect(isProjectHidden(exclude, null)).toBe(false);
  });
});

describe('project filter persistence', () => {
  it('round-trips through localStorage', () => {
    writeProjectFilter({ exclude: true, ids: new Set([7, 9]) });
    const f = readProjectFilter();
    expect(f.exclude).toBe(true);
    expect([...f.ids].sort()).toEqual([7, 9]);
  });

  it('parses a legacy bare id array as an include filter', () => {
    const f = parseProjectFilter('[7,9]');
    expect(f.exclude).toBe(false);
    expect([...f.ids].sort()).toEqual([7, 9]);
  });

  it('returns an empty filter for missing or corrupt values', () => {
    expect(readProjectFilter().ids.size).toBe(0);
    expect(parseProjectFilter('not json').ids.size).toBe(0);
  });

  it('serializes deterministically for storage', () => {
    expect(serializeProjectFilter({ exclude: false, ids: new Set([7]) })).toBe('{"exclude":false,"ids":[7]}');
    expect(serializeProjectFilter({ exclude: true, ids: new Set([9]) })).toBe('{"exclude":true,"ids":[9]}');
  });
});
