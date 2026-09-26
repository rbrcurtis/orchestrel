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

describe('toggleProjectFilter — per-project click cycle', () => {
  it('first click includes the project', () => {
    const next = toggleProjectFilter(makeProjectFilter(), 7);
    expect([...next.include]).toEqual([7]);
    expect(next.exclude.size).toBe(0);
  });

  it('second click on an included project excludes it', () => {
    const next = toggleProjectFilter({ include: new Set([7]), exclude: new Set<number>() }, 7);
    expect(next.include.size).toBe(0);
    expect([...next.exclude]).toEqual([7]);
  });

  it('third click on an excluded project clears it', () => {
    const next = toggleProjectFilter({ include: new Set<number>(), exclude: new Set([7]) }, 7);
    expect(next.include.size).toBe(0);
    expect(next.exclude.size).toBe(0);
  });
});

describe('toggleProjectFilter — independent projects', () => {
  it('clicking a different project adds it to the include set', () => {
    const next = toggleProjectFilter({ include: new Set([7]), exclude: new Set<number>() }, 9);
    expect([...next.include].sort()).toEqual([7, 9]);
    expect(next.exclude.size).toBe(0);
  });

  it('clicking a project while excluding another includes it and keeps the exclusion', () => {
    // Exclude 7 (double click), then click 9 once → "!7 AND 9".
    const next = toggleProjectFilter({ include: new Set<number>(), exclude: new Set([7]) }, 9);
    expect([...next.include]).toEqual([9]);
    expect([...next.exclude]).toEqual([7]);
  });

  it('clicking one of several included projects moves only it to excluded', () => {
    const next = toggleProjectFilter({ include: new Set([7, 9]), exclude: new Set<number>() }, 7);
    expect([...next.include]).toEqual([9]);
    expect([...next.exclude]).toEqual([7]);
  });

  it('clicking the sole excluded project while another is included just clears the exclusion', () => {
    const next = toggleProjectFilter({ include: new Set([9]), exclude: new Set([7]) }, 7);
    expect([...next.include]).toEqual([9]);
    expect(next.exclude.size).toBe(0);
  });

  it('can exclude several projects by clicking each twice', () => {
    let f = makeProjectFilter();
    for (const id of [7, 9]) {
      f = toggleProjectFilter(f, id);
      f = toggleProjectFilter(f, id);
    }
    expect(f.include.size).toBe(0);
    expect([...f.exclude].sort()).toEqual([7, 9]);
  });
});

describe('isProjectHidden', () => {
  it('shows everything when the filter is inactive', () => {
    expect(isProjectHidden(makeProjectFilter(), 7)).toBe(false);
    expect(isProjectHidden(makeProjectFilter(), null)).toBe(false);
  });

  it('include filter hides projects outside the set', () => {
    const f = { include: new Set([7]), exclude: new Set<number>() };
    expect(isProjectHidden(f, 7)).toBe(false);
    expect(isProjectHidden(f, 8)).toBe(true);
  });

  it('exclude filter hides only the listed projects', () => {
    const f = { include: new Set<number>(), exclude: new Set([7]) };
    expect(isProjectHidden(f, 7)).toBe(true);
    expect(isProjectHidden(f, 8)).toBe(false);
  });

  it('mixed filter hides excluded projects and non-included projects', () => {
    // "!7 AND 9" → only project 9 is visible.
    const f = { include: new Set([9]), exclude: new Set([7]) };
    expect(isProjectHidden(f, 7)).toBe(true);
    expect(isProjectHidden(f, 8)).toBe(true);
    expect(isProjectHidden(f, 9)).toBe(false);
  });

  it('cards without a project are hidden only by include filters', () => {
    const include = { include: new Set([7]), exclude: new Set<number>() };
    const exclude = { include: new Set<number>(), exclude: new Set([7]) };
    expect(isProjectHidden(include, null)).toBe(true);
    expect(isProjectHidden(exclude, null)).toBe(false);
  });
});

describe('project filter persistence', () => {
  it('round-trips through localStorage', () => {
    writeProjectFilter({ include: new Set([9]), exclude: new Set([7]) });
    const f = readProjectFilter();
    expect([...f.include]).toEqual([9]);
    expect([...f.exclude]).toEqual([7]);
  });

  it('parses a legacy bare id array as an include filter', () => {
    const f = parseProjectFilter('[7,9]');
    expect([...f.include].sort()).toEqual([7, 9]);
    expect(f.exclude.size).toBe(0);
  });

  it('parses the previous {exclude, ids} object shape', () => {
    const include = parseProjectFilter('{"exclude":false,"ids":[7]}');
    expect([...include.include]).toEqual([7]);
    const exclude = parseProjectFilter('{"exclude":true,"ids":[7,9]}');
    expect([...exclude.exclude].sort()).toEqual([7, 9]);
    expect(exclude.include.size).toBe(0);
  });

  it('returns an empty filter for missing or corrupt values', () => {
    expect(readProjectFilter().include.size).toBe(0);
    expect(readProjectFilter().exclude.size).toBe(0);
    expect(parseProjectFilter('not json').include.size).toBe(0);
  });

  it('serializes deterministically for storage', () => {
    expect(serializeProjectFilter({ include: new Set([7]), exclude: new Set([9]) })).toBe(
      '{"include":[7],"exclude":[9]}',
    );
  });
});
