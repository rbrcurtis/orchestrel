import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockList = vi.fn();
const mockOpen = vi.fn();
const mockBuildSessionContext = vi.fn();

vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: {
    list: mockList,
    open: mockOpen,
  },
}));

describe('getPiSessionMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([
      { id: 'other-session', path: '/home/ryan/.pi/agent/sessions/--repo--/other.jsonl' },
      { id: 'pi-session-1', path: '/home/ryan/.pi/agent/sessions/--repo--/pi-session-1.jsonl' },
    ]);
    mockOpen.mockReturnValue({ buildSessionContext: mockBuildSessionContext });
    mockBuildSessionContext.mockReturnValue({
      messages: [
        { role: 'user', content: 'hello', timestamp: 1 },
        {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'toolCall', id: 'tool-1', name: 'Read', arguments: { file_path: '/repo/README.md' } },
          ],
          stopReason: 'toolUse',
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'tool-1',
          toolName: 'Read',
          content: [{ type: 'text', text: 'file contents' }],
          isError: false,
          timestamp: 3,
        },
      ],
    });
  });

  it('loads messages from Pi session storage', async () => {
    const { getPiSessionMessages } = await import('./pi-session-history');

    const messages = await getPiSessionMessages('pi-session-1', '/repo');

    expect(messages).toEqual([
      {
        type: 'user',
        uuid: 'pi-session-1-pi-history-0',
        session_id: 'pi-session-1',
        parent_tool_use_id: null,
        timestamp: 1,
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        uuid: 'pi-session-1-pi-history-1',
        session_id: 'pi-session-1',
        parent_tool_use_id: null,
        timestamp: 2,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/repo/README.md' } },
          ],
          stop_reason: 'toolUse',
          usage: undefined,
        },
      },
      {
        type: 'user',
        uuid: 'pi-session-1-pi-history-2',
        session_id: 'pi-session-1',
        parent_tool_use_id: null,
        timestamp: 3,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [{ type: 'text', text: 'file contents' }],
            is_error: false,
          }],
        },
      },
    ]);
    expect(mockList).toHaveBeenCalledWith('/repo');
    expect(mockOpen).toHaveBeenCalledWith(
      '/home/ryan/.pi/agent/sessions/--repo--/pi-session-1.jsonl',
      undefined,
      '/repo',
    );
    expect(mockBuildSessionContext).toHaveBeenCalledOnce();
  });

  it('skips unsupported Pi message roles instead of creating fake user turns', async () => {
    const { getPiSessionMessages } = await import('./pi-session-history');
    mockBuildSessionContext.mockReturnValue({
      messages: [
        { role: 'custom', customType: 'notice', content: [{ type: 'text', text: 'custom note' }] },
        { role: 'bashExecution', command: 'ls', output: 'README.md', timestamp: 5 },
        { role: 'branchSummary', summary: 'older branch', timestamp: 6 },
      ],
    });

    await expect(getPiSessionMessages('pi-session-1', '/repo')).resolves.toEqual([]);
  });

  it('emits a system init history entry when Pi context has model metadata', async () => {
    const { getPiSessionMessages } = await import('./pi-session-history');
    mockBuildSessionContext.mockReturnValue({
      model: { provider: 'anthropic', modelId: 'claude-opus-4-5' },
      thinkingLevel: 'xhigh',
      messages: [{ role: 'user', content: 'hello' }],
    });

    await expect(getPiSessionMessages('pi-session-1', '/repo')).resolves.toEqual([
      {
        type: 'system',
        subtype: 'init',
        uuid: 'pi-session-1-pi-history-init',
        session_id: 'pi-session-1',
        parent_tool_use_id: null,
        model: 'claude-opus-4-5',
        thinking_level: 'xhigh',
      },
      {
        type: 'user',
        uuid: 'pi-session-1-pi-history-0',
        session_id: 'pi-session-1',
        parent_tool_use_id: null,
        timestamp: undefined,
        message: { role: 'user', content: 'hello' },
      },
    ]);
  });

  it('returns [] when the Pi API cannot find the session', async () => {
    const { getPiSessionMessages } = await import('./pi-session-history');
    mockList.mockResolvedValue([{ id: 'other-session', path: '/tmp/other.jsonl' }]);

    await expect(getPiSessionMessages('missing-session', '/repo')).resolves.toEqual([]);

    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('returns [] when the Pi API fails', async () => {
    const { getPiSessionMessages } = await import('./pi-session-history');
    mockList.mockRejectedValue(new Error('storage unavailable'));

    await expect(getPiSessionMessages('pi-session-1', '/repo')).resolves.toEqual([]);
  });

  it('returns [] when the expected Pi API is absent', async () => {
    const { getPiSessionMessages } = await import('./pi-session-history');
    mockOpen.mockReturnValue({});

    await expect(getPiSessionMessages('pi-session-1', '/repo')).resolves.toEqual([]);
  });
});
