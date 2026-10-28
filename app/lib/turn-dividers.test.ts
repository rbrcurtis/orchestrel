import { describe, expect, it } from 'vitest';
import { withTurnDividers } from './turn-dividers';
import type { ConversationEntry } from './message-accumulator';

const at = (h: number) => Date.UTC(2026, 9, 27, h, 0, 0);

describe('withTurnDividers', () => {
  it('puts a turn-start divider above every prompt, carrying its time', () => {
    const conversation: ConversationEntry[] = [
      { kind: 'system', subtype: 'init', model: 'deepseek-flash', timestamp: at(9) },
      { kind: 'user', content: 'first prompt', timestamp: at(10) },
      { kind: 'blocks', blocks: [] },
      { kind: 'result', data: {} as never, timestamp: at(11) },
      { kind: 'user', content: 'second prompt', timestamp: at(12) },
    ];

    expect(withTurnDividers(conversation).map((e) => [e.kind, e.timestamp])).toEqual([
      ['system', at(9)],
      ['turn_started', at(10)],
      ['user', at(10)],
      ['blocks', undefined],
      ['result', at(11)],
      ['turn_started', at(12)],
      ['user', at(12)],
    ]);
  });

  it('leaves a conversation with no prompts alone', () => {
    const conversation: ConversationEntry[] = [{ kind: 'blocks', blocks: [] }];
    expect(withTurnDividers(conversation)).toEqual(conversation);
  });
});
