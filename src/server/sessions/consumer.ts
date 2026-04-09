// src/server/sessions/consumer.ts

import type { ActiveSession } from './types';
import { messageBus } from '../bus';
import { sendToMeridian } from './meridian-client';
import { translateEvent, buildResultMessage } from './event-translator';
import { getMessages, addAssistantMessage } from './conversation-store';

function statusPayload(session: ActiveSession, active: boolean) {
  return {
    cardId: session.cardId,
    active,
    status: session.status,
    sessionId: session.sessionId,
    promptsSent: session.promptsSent,
    turnsCompleted: session.turnsCompleted,
    contextTokens: 0,
    contextWindow: 200_000,
  };
}

/**
 * Send a request to meridian and consume the SSE stream.
 * Publishes translated events to the message bus.
 */
export async function consumeSession(
  session: ActiveSession,
  systemPrompt: string,
  onExit: (session: ActiveSession) => void,
): Promise<void> {
  const { cardId } = session;
  const log = (msg: string) => console.log(`[session:${session.sessionId ?? cardId}] ${msg}`);
  const profile = session.provider === 'anthropic' ? undefined : session.provider;

  try {
    const meridian = await sendToMeridian({
      model: session.model,
      messages: getMessages(cardId),
      system: systemPrompt,
      sessionId: session.meridianSessionId,
      profile,
      signal: session.abortController.signal,
    });

    session.status = 'running';
    messageBus.publish(`card:${cardId}:status`, statusPayload(session, true));

    const contentBlocks: unknown[] = [];
    let usage: Record<string, unknown> | null = null;

    for await (const sse of meridian.events) {
      const msg = translateEvent(sse);
      if (!msg) continue;

      // Track session ID from message_start
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        if (!session.sessionId) {
          session.sessionId = msg.session_id as string;
          log(`init sessionId=${session.sessionId}`);
        }
      }

      // Track content blocks for conversation store
      if (msg.type === 'stream_event') {
        const evt = msg.event as Record<string, unknown>;
        if (evt.type === 'content_block_start') {
          contentBlocks.push(evt.content_block);
        }
        if (evt.type === 'content_block_delta') {
          // Update last content block with delta
          const idx = evt.index as number;
          const delta = evt.delta as Record<string, unknown>;
          const block = contentBlocks[idx] as Record<string, unknown> | undefined;
          if (block?.type === 'text' && delta.type === 'text_delta') {
            block.text = ((block.text as string) ?? '') + (delta.text as string);
          }
        }
        if (evt.type === 'message_delta') {
          usage = (evt.usage as Record<string, unknown>) ?? null;
        }
      }

      // Forward to UI
      messageBus.publish(`card:${cardId}:sdk`, msg);
    }

    // Store assistant response in conversation
    if (contentBlocks.length > 0) {
      addAssistantMessage(cardId, contentBlocks);
    }

    session.turnsCompleted++;
    session.turnCost = 0; // meridian doesn't expose cost in SSE yet
    log(`turn complete turns=${session.turnsCompleted}`);

    // Publish result
    messageBus.publish(`card:${cardId}:sdk`, buildResultMessage(session.turnCost, usage));

    session.status = 'completed';
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes('aborted') || errMsg.includes('AbortError')) {
      log(`consumer stopped cleanly: ${errMsg}`);
      if (session.status !== 'completed') session.status = 'stopped';
    } else {
      log(`consumer error: ${err}`);
      session.status = 'errored';
      messageBus.publish(`card:${cardId}:sdk`, {
        type: 'error',
        message: errMsg,
        timestamp: Date.now(),
      });
    }
  } finally {
    if (session.status === 'running') session.status = 'completed';
    log(`consumer exited (status=${session.status})`);
    messageBus.publish(`card:${cardId}:exit`, {
      sessionId: session.sessionId,
      status: session.status,
    });
    onExit(session);
  }
}
