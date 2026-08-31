import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendTelegramAlert } from './telegram';

afterEach(() => vi.unstubAllGlobals());

describe('sendTelegramAlert', () => {
  it('posts to the sendMessage endpoint and returns true on ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') }));
    await expect(sendTelegramAlert('bot', 'chat', 'hello')).resolves.toBe(true);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botbot/sendMessage');
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: 'chat', text: 'hello' });
  });

  it('throws on non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('bad') }));
    await expect(sendTelegramAlert('bot', 'chat', 'x')).rejects.toThrow('400');
  });
});
