import { describe, expect, it } from 'vitest';
import { MessageAccumulator } from './message-accumulator';
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
});
