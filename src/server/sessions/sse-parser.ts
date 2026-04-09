export interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Parse an SSE byte stream into event objects.
 * Yields one SSEEvent per double-newline-delimited block.
 */
export async function* parseSSEStream(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = 'message';
      const dataLines: string[] = [];

      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) {
          event = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          dataLines.push(line.slice(6));
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5));
        }
      }

      if (dataLines.length > 0) {
        yield { event, data: dataLines.join('\n') };
      }
    }
  }
}
