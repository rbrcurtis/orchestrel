// src/server/sessions/consumer.ts

import type { ActiveSession } from './types';
import { messageBus } from '../bus';
import { sendToMeridian, getClaudeSessionId } from './meridian-client';
import { translateEvent, buildResultMessage } from './event-translator';

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
  prompt: string,
  systemPrompt: string,
  onExit: (session: ActiveSession) => void,
): Promise<void> {
  const { cardId } = session;
  const log = (msg: string) => console.log(`[session:${session.sessionId ?? cardId}] ${msg}`);
  const profile = session.provider === 'anthropic' ? undefined : session.provider;

  try {
    const meridian = await sendToMeridian({
      model: session.model,
      messages: [{ role: 'user', content: prompt }],
      system: systemPrompt,
      sessionId: session.meridianSessionId,
      profile,
      signal: session.abortController.signal,
    });

    session.status = 'running';
    messageBus.publish(`card:${cardId}:status`, statusPayload(session, true));

    let usage: Record<string, unknown> | null = null;
    let initSent = false;

    for await (const sse of meridian.events) {
      const msg = translateEvent(sse);
      if (!msg) continue;

      // Track session ID from first message_start only.
      // Subsequent message_start events (from multi-turn agentic loops in
      // non-passthrough mode) are forwarded as stream_events so the
      // accumulator resets blocks between turns without rendering
      // duplicate "Session started" entries.
      if (msg.type === 'system' && msg.subtype === 'init') {
        if (!initSent) {
          initSent = true;
        } else {
          messageBus.publish(`card:${cardId}:sdk`, {
            type: 'stream_event',
            event: { type: 'message_start' },
          });
          continue;
        }
      }

      if (msg.type === 'stream_event') {
        const evt = msg.event as Record<string, unknown>;
        if (evt.type === 'message_delta') {
          usage = (evt.usage as Record<string, unknown>) ?? null;
        }
      }

      // Forward to UI
      messageBus.publish(`card:${cardId}:sdk`, msg);
    }

    // Resolve real Claude Code session UUID from meridian's session store.
    // Must happen after stream ends — meridian stores the mapping post-response.
    if (!session.sessionId || session.sessionId.startsWith('msg_')) {
      const ccSessionId = await getClaudeSessionId(session.meridianSessionId);
      if (ccSessionId) {
        session.sessionId = ccSessionId;
        log(`resolved claudeSessionId=${ccSessionId}`);
        // Publish so oc.ts persists it to the card
        messageBus.publish(`card:${cardId}:sdk`, {
          type: 'system',
          subtype: 'init',
          session_id: ccSessionId,
        });
      }
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
