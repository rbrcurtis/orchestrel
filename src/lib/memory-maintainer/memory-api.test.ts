import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryServer } from './memory-api';
import { searchMemories, storeMemory, updateMemory, deleteMemory } from './memory-api';

const SERVER: MemoryServer = { apiUrl: 'http://mem.test', apiKey: 'sek', project: 'trackable' };

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve('err'),
    json: () => Promise.resolve(body),
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('memory-api', () => {
  it('searches with project scoping and bearer auth', async () => {
    mockFetch(200, { data: [{ id: '1', title: 't', text: 'x', score: 0.5 }] });
    const hits = await searchMemories(SERVER, 'pipeline', 5);
    expect(hits).toEqual([{ id: '1', title: 't', text: 'x', score: 0.5 }]);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/memories/search');
    expect(url).toContain('query=pipeline');
    expect(url).toContain('project=trackable');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sek' });
  });

  it('stores with project in the body', async () => {
    mockFetch(200, { data: { id: '9' } });
    const { id } = await storeMemory(SERVER, { title: 't', text: 'x', tags: ['a'] });
    expect(id).toBe('9');
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ title: 't', text: 'x', tags: ['a'], project: 'trackable' });
  });

  it('updates and deletes by id', async () => {
    mockFetch(200, { data: { success: true } });
    expect((await updateMemory(SERVER, { id: '1', text: 'new' })).success).toBe(true);
    expect((await deleteMemory(SERVER, '1')).success).toBe(true);
  });

  it('throws on non-ok responses', async () => {
    mockFetch(500, {});
    await expect(searchMemories(SERVER, 'x')).rejects.toThrow('500');
  });
});
