import type { TranscriptState } from '../../src/shared/transcript-sync';
import { MessageAccumulator } from './message-accumulator';
import type { HistoryMessage } from './sdk-types';

export function renderTranscriptSnapshot(accumulator: MessageAccumulator, state: TranscriptState): void {
  accumulator.clear();
  const records = [
    ...state.baseline.flatMap((entry) =>
      entry.messages.map((message, part) => ({ id: `${entry.entryId}:${part}`, message })),
    ),
    ...state.overlay.map((entry) => ({ id: entry.lifecycleId, message: entry.message })),
  ].slice(-120);
  for (const { id, message } of records) {
    const base = {
      uuid: id,
      session_id: '',
      parent_tool_use_id: null,
      timestamp: 'timestamp' in message ? message.timestamp : undefined,
    };
    if (message.role === 'user') {
      accumulator.handleHistoryMessage({
        ...base,
        type: 'user',
        message: { role: 'user', content: message.content },
      } as HistoryMessage);
    } else if (message.role === 'assistant') {
      accumulator.handleHistoryMessage({
        ...base,
        type: 'assistant',
        message: {
          role: 'assistant',
          model: message.model,
          content: message.content.map((block) =>
            block.type === 'toolCall'
              ? { type: 'tool_use', id: block.id, name: block.name, input: block.arguments }
              : block,
          ),
        },
      } as HistoryMessage);
    } else if (message.role === 'toolResult') {
      accumulator.handleHistoryMessage({
        ...base,
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content: message.content,
              is_error: message.isError,
            },
          ],
        },
      } as HistoryMessage);
    } else if (message.role === 'compactionSummary') {
      accumulator.handleHistoryMessage({ ...base, type: 'system', subtype: 'compact_boundary' } as HistoryMessage);
    }
  }
  if (state.overlay.length === 0) accumulator.flushHistory();
}
