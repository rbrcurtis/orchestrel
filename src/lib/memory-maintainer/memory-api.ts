/* Memory API REST client. Plain fetch, Bearer auth. Endpoint shapes mirror
 * memory-mcp's client.ts (POST /api/v1/memories, GET /api/v1/memories/search,
 * PUT/DELETE /api/v1/memories/:id). No SDK. */
export interface MemoryServer {
  apiUrl: string;
  apiKey: string;
  project: string;
}

export interface MemoryHit {
  id: string;
  title: string;
  text: string;
  score: number;
}

export type StagedOp =
  | { op: 'store'; title: string; text: string; tags?: string[] }
  | { op: 'update'; id: string; title?: string; text: string }
  | { op: 'delete'; id: string; reason?: string }
  | { op: 'skip'; reason: string };

async function request<T>(server: MemoryServer, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${server.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`memory api ${method} ${path}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function searchMemories(server: MemoryServer, query: string, limit = 10): Promise<MemoryHit[]> {
  const qs = new URLSearchParams({ query, limit: String(limit), project: server.project });
  const data = await request<{ data: unknown[] }>(server, 'GET', `/api/v1/memories/search?${qs}`);
  return data.data as MemoryHit[];
}

export async function storeMemory(
  server: MemoryServer,
  params: { title: string; text: string; tags?: string[] },
): Promise<{ id: string }> {
  const data = await request<{ data: { id: string } }>(server, 'POST', '/api/v1/memories', {
    title: params.title,
    text: params.text,
    ...(params.tags ? { tags: params.tags } : {}),
    project: server.project,
  });
  return data.data;
}

export async function updateMemory(
  server: MemoryServer,
  params: { id: string; title?: string; text: string },
): Promise<{ success: boolean }> {
  const data = await request<{ data: { success: boolean } }>(server, 'PUT', `/api/v1/memories/${params.id}`, {
    text: params.text,
    ...(params.title ? { title: params.title } : {}),
  });
  return data.data;
}

export async function deleteMemory(server: MemoryServer, id: string): Promise<{ success: boolean }> {
  const data = await request<{ data: { success: boolean } }>(server, 'DELETE', `/api/v1/memories/${id}`);
  return data.data;
}

export async function loadMemory(server: MemoryServer, id: string): Promise<MemoryHit | null> {
  const qs = new URLSearchParams({ ids: id });
  const data = await request<{ data: unknown[] }>(server, 'GET', `/api/v1/memories/load?${qs}`);
  return (data.data[0] as MemoryHit | undefined) ?? null;
}
