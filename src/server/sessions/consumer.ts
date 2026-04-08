import type { ActiveSession } from './types';
import { messageBus } from '../bus';

/** SDK message types to forward to the UI */
const FORWARD_TYPES = new Set([
  'system',
  'stream_event',
  'assistant',
  'result',
  'tool_progress',
  'tool_use_summary',
  'task_started',
  'task_progress',
  'task_notification',
  'rate_limit',
  'status',
]);

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
 * Consumes the SDK Query async generator for a session.
 * Updates session state, publishes forwarded messages to the bus.
 * Runs as a fire-and-forget async task — one per active session.
 */
export async function consumeSession(
  session: ActiveSession,
  onExit: (session: ActiveSession) => void,
): Promise<void> {
  const { cardId } = session;
  const log = (msg: string) => console.log(`[session:${session.sessionId ?? cardId}] ${msg}`);

  try {
    for await (const msg of session.query) {
      const sdkMsg = msg as Record<string, unknown>;

      switch (sdkMsg.type) {
        case 'system': {
          const sys = sdkMsg as { subtype?: string; session_id?: string };
          if (sys.subtype === 'init' && sys.session_id) {
            session.sessionId = sys.session_id;
            session.status = 'running';
            log(`init sessionId=${sys.session_id}`);
            messageBus.publish(`card:${cardId}:status`, statusPayload(session, true));
          }
          break;
        }

        case 'assistant':
        case 'stream_event':
          if (session.status !== 'running') {
            session.status = 'running';
            messageBus.publish(`card:${cardId}:status`, statusPayload(session, true));
          }
          break;

        case 'result': {
          const result = sdkMsg as {
            subtype?: string;
            total_cost_usd?: number;
            usage?: Record<string, unknown>;
            num_turns?: number;
            duration_ms?: number;
          };
          session.turnsCompleted++;
          session.turnCost = result.total_cost_usd ?? 0;
          session.status = 'completed';
          log(`result subtype=${result.subtype} cost=$${session.turnCost} turns=${session.turnsCompleted}`);
          messageBus.publish(`card:${cardId}:status`, statusPayload(session, false));
          break;
        }

        case 'rate_limit':
          session.status = 'retry';
          log('rate_limit');
          messageBus.publish(`card:${cardId}:status`, statusPayload(session, true));
          break;

        default:
          break;
      }

      // Forward displayable messages to UI subscribers
      if (FORWARD_TYPES.has(sdkMsg.type as string)) {
        messageBus.publish(`card:${cardId}:sdk`, sdkMsg);
      }
    }
  } catch (err) {
    // Ignore "Query closed" errors — these happen when stop() is called during cleanup
    const errMsg = String(err);
    if (errMsg.includes('Query closed before response received') || errMsg.includes('Operation aborted')) {
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
    log(`consumer exited (status=${session.status})`);
    messageBus.publish(`card:${cardId}:exit`, {
      sessionId: session.sessionId,
      status: session.status,
    });
    onExit(session);
  }
}
