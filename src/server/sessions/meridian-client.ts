import { parseSSEStream, type SSEEvent } from './sse-parser';

const MERIDIAN_URL = process.env.MERIDIAN_URL ?? 'http://127.0.0.1:3456';

export interface MeridianRequestOpts {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  sessionId: string;
  profile?: string; // meridian profile name (e.g. 'kiro')
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface MeridianSession {
  events: AsyncGenerator<SSEEvent>;
  response: Response;
  abort: () => void;
}

/**
 * Send a streaming request to meridian and return the SSE event stream.
 */
/**
 * Query meridian's session recovery endpoint to get the real Claude Code session UUID.
 * Meridian prefixes session keys with "{profileId}:" for non-default profiles,
 * so we try multiple key formats.
 */
export async function getClaudeSessionId(meridianSessionId: string): Promise<string | null> {
  // Try the raw key, then common profile-prefixed variants
  const candidates = [
    meridianSessionId,
    `kiro:${meridianSessionId}`,
  ];

  for (const key of candidates) {
    try {
      const res = await fetch(`${MERIDIAN_URL}/v1/sessions/${encodeURIComponent(key)}/recover`);
      if (res.ok) {
        const data = await res.json() as { claudeSessionId?: string };
        if (data.claudeSessionId) return data.claudeSessionId;
      }
    } catch {
      // continue to next candidate
    }
  }
  return null;
}

/**
 * Send a streaming request to meridian and return the SSE event stream.
 */
export async function sendToMeridian(opts: MeridianRequestOpts): Promise<MeridianSession> {
  const controller = new AbortController();
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => controller.abort());
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': 'orchestrel',
    'x-opencode-session': opts.sessionId,
  };
  if (opts.profile) {
    headers['x-meridian-profile'] = opts.profile;
  }

  const body = JSON.stringify({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 16384,
    stream: true,
    ...(opts.system ? { system: opts.system } : {}),
    messages: opts.messages,
  });

  const response = await fetch(`${MERIDIAN_URL}/v1/messages`, {
    method: 'POST',
    headers,
    body,
    signal: controller.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Meridian error ${response.status}: ${text}`);
  }

  if (!response.body) {
    throw new Error('Meridian returned no body');
  }

  return {
    events: parseSSEStream(response.body as unknown as AsyncIterable<Uint8Array>),
    response,
    abort: () => controller.abort(),
  };
}
