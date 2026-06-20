import { describe, expect, it } from 'vitest';
import { MessageAccumulator, ContentBlock } from './message-accumulator';
import type { SdkMessage } from './sdk-types';

function toolStart(id: string): SdkMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id,
        name: 'Agent',
      },
    },
  };
}

function toolInput(partialJson: string): SdkMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: partialJson,
      },
    },
  };
}

function toolStop(): SdkMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_stop',
      index: 0,
    },
  };
}

describe('MessageAccumulator compaction markers', () => {
  it('surfaces BGC start messages as compact markers', () => {
    const acc = new MessageAccumulator();
    const timestamp = Date.UTC(2026, 3, 27, 12, 0, 0);

    acc.handleMessage({
      type: 'system',
      subtype: 'bgc_started',
      timestamp,
    } as SdkMessage);

    expect(acc.conversation).toEqual([{ kind: 'compact', label: 'Background compaction started', timestamp }]);
  });

  it('surfaces BGC applied messages as compact markers', () => {
    const acc = new MessageAccumulator();
    const timestamp = Date.UTC(2026, 3, 27, 12, 1, 0);

    acc.handleMessage({
      type: 'system',
      subtype: 'compact_boundary',
      source: 'orchestrel-bgc',
      timestamp,
    } as SdkMessage);

    expect(acc.conversation).toEqual([{ kind: 'compact', label: 'Background compaction applied', timestamp }]);
  });
});

describe('MessageAccumulator blocking subagents', () => {
  it('surfaces blocking Agent tool_use blocks as running subagents', () => {
    const acc = new MessageAccumulator();

    acc.handleMessage(toolStart('call_agent'));
    acc.handleMessage(toolInput('{"description":"Implement task","run_in_background":false}'));
    acc.handleMessage(toolStop());

    expect(acc.subagents.get('call_agent')).toEqual({
      taskId: 'call_agent',
      description: 'Implement task',
      status: 'running',
      lastProgress: 'Running',
    });
  });

  it('marks blocking Agent subagent completed when tool result summary arrives', () => {
    const acc = new MessageAccumulator();

    acc.handleMessage(toolStart('call_agent'));
    acc.handleMessage(toolInput('{"description":"Implement task"}'));
    acc.handleMessage(toolStop());
    acc.handleMessage({
      type: 'tool_use_summary',
      tool_name: 'Agent',
      tool_input: { description: 'Implement task' },
      tool_result: 'DONE',
      tool_use_id: 'call_agent',
    } as SdkMessage);

    expect(acc.subagents.get('call_agent')?.status).toBe('completed');
    expect(acc.subagents.get('call_agent')?.lastProgress).toBe('DONE');
  });

  it('marks blocking Agent subagent completed when SDK user tool_result arrives', () => {
    const acc = new MessageAccumulator();

    acc.handleMessage(toolStart('call_agent'));
    acc.handleMessage(toolInput('{"description":"Review subagent UI fix"}'));
    acc.handleMessage(toolStop());
    acc.handleMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_agent',
            content: [{ type: 'text', text: 'Strong implementation overall.' }],
            is_error: false,
          },
        ],
      },
    } as SdkMessage);

    expect(acc.subagents.get('call_agent')?.status).toBe('completed');
    expect(acc.subagents.get('call_agent')?.lastProgress).toBe('Strong implementation overall.');
  });

  it('does not surface async Agent tool_use blocks as blocking subagents', () => {
    const acc = new MessageAccumulator();

    acc.handleMessage(toolStart('call_agent'));
    acc.handleMessage(toolInput('{"description":"Async task","run_in_background":true}'));
    acc.handleMessage(toolStop());

    expect(acc.subagents.has('call_agent')).toBe(false);
  });

  it('does not complete a cleared blocking subagent from stale tool ids', () => {
    const acc = new MessageAccumulator();

    acc.handleMessage(toolStart('call_agent'));
    acc.handleMessage(toolInput('{"description":"Implement task"}'));
    acc.handleMessage(toolStop());
    acc.clear();
    acc.handleMessage({
      type: 'tool_use_summary',
      tool_name: 'Agent',
      tool_input: { description: 'Implement task' },
      tool_result: 'DONE',
      tool_use_id: 'call_agent',
    } as SdkMessage);

    expect(acc.subagents.has('call_agent')).toBe(false);
  });

  it('attaches SDK user tool_result output to the matching tool block', () => {
    const acc = new MessageAccumulator();

    acc.handleMessage(toolStart('call_read'));
    acc.handleMessage(toolInput('{"file_path":"/tmp/example.txt"}'));
    acc.handleMessage(toolStop());
    acc.handleMessage({ type: 'stream_event', event: { type: 'message_stop' } } as SdkMessage);
    acc.handleMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_read',
            content: [{ type: 'text', text: 'file contents' }],
            is_error: false,
          },
        ],
      },
    } as SdkMessage);

    const entry = acc.conversation[0];
    expect(entry.kind).toBe('blocks');
    if (entry.kind !== 'blocks') return;
    expect(entry.blocks[0].output).toBe('file contents');
  });
});

describe('MessageAccumulator serialize/hydrate', () => {
  it('round-trips conversation, rebuilding ContentBlock instances', () => {
    const acc = new MessageAccumulator();
    acc.handleHistoryMessage({
      type: 'assistant',
      uuid: 'msg_1',
      session_id: 'sess_1',
      parent_tool_use_id: null,
      timestamp: Date.UTC(2026, 5, 19, 12, 0, 0),
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file: 'a.ts' } },
        ],
      },
    });
    acc.flushHistory();

    const snapshot = acc.serialize();
    // snapshot must survive a JSON round-trip (this is what IndexedDB stores)
    const wireSafe = JSON.parse(JSON.stringify(snapshot)) as unknown[];

    const restored = new MessageAccumulator();
    restored.hydrate(wireSafe);

    expect(restored.conversation.length).toBe(acc.conversation.length);
    const blocksEntry = restored.conversation.find((e) => e.kind === 'blocks');
    expect(blocksEntry).toBeDefined();
    if (blocksEntry?.kind !== 'blocks') throw new Error('expected blocks entry');
    const toolBlock = blocksEntry.blocks.find((b) => b.type === 'tool_use');
    expect(toolBlock).toBeInstanceOf(ContentBlock);
    expect(toolBlock?.id).toBe('tool_1');
    expect(toolBlock?.input).toBe(JSON.stringify({ file: 'a.ts' }));
    expect(toolBlock?.complete).toBe(true);
  });

  it('hydrate replaces existing conversation', () => {
    const acc = new MessageAccumulator();
    acc.addUserMessage('first');
    acc.hydrate([{ kind: 'user', content: 'second' }]);
    expect(acc.conversation.length).toBe(1);
    expect(acc.conversation[0]).toMatchObject({ kind: 'user', content: 'second' });
  });
});
