import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: () =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 600000 } }),
  };
});

import { claudeMaxOAuth } from '../auth';

describe('claudeMaxOAuth block', () => {
  it('login() reads ~/.claude credentials headlessly into OAuthCredentials shape', async () => {
    const creds = await claudeMaxOAuth.login({} as never);
    expect(creds.access).toBe('A');
    expect(creds.refresh).toBe('R');
    expect(typeof creds.expires).toBe('number');
  });

  it('getApiKey returns the access token', () => {
    expect(claudeMaxOAuth.getApiKey({ access: 'A', refresh: 'R', expires: 1 })).toBe('A');
  });
});
