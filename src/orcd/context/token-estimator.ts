import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ImageContent,
  ThinkingContent,
  RedactedThinkingContent,
  ToolCall,
} from '@oh-my-pi/pi-ai';

const CHARS_PER_TOKEN = 3.5;
const MSG_OVERHEAD = 4;
const IMAGE_TOKENS = 1000;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.floor(text.length / CHARS_PER_TOKEN);
}

function estimateTextOrImageContent(
  blocks: (TextContent | ImageContent)[],
): number {
  let total = 0;
  for (const b of blocks) {
    if (b.type === 'text') total += estimateTokens(b.text);
    else if (b.type === 'image') total += IMAGE_TOKENS;
  }
  return total;
}

function estimateAssistantContent(
  blocks: (TextContent | ThinkingContent | RedactedThinkingContent | ToolCall)[],
): number {
  let total = 0;
  for (const b of blocks) {
    if (b.type === 'text') total += estimateTokens(b.text);
    else if (b.type === 'thinking') total += estimateTokens(b.thinking);
    else if (b.type === 'toolCall')
      total += estimateTokens(b.name + JSON.stringify(b.arguments));
    // redactedThinking: no readable text, skip
  }
  return total;
}

export function estimateMessageTokens(msg: Message): number {
  const overhead = MSG_OVERHEAD;

  if (msg.role === 'user' || msg.role === 'developer') {
    const { content } = msg as UserMessage;
    if (typeof content === 'string') {
      return estimateTokens(content) + overhead;
    }
    return estimateTextOrImageContent(content) + overhead;
  }

  if (msg.role === 'assistant') {
    const a = msg as AssistantMessage;
    if (a.usage.output > 0) {
      return a.usage.output + overhead;
    }
    return estimateAssistantContent(a.content) + overhead;
  }

  if (msg.role === 'toolResult') {
    const t = msg as ToolResultMessage;
    return estimateTextOrImageContent(t.content) + overhead;
  }

  return overhead;
}
