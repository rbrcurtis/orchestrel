/* oxlint-disable orchestrel/log-before-early-return -- pure parser/tracker guard returns are intentional */

// Background subagent lifecycle tracking, keyed off pi-subagents' STRUCTURED
// event details — never the LLM-facing prose. Two sources:
//
//  1. Launch: the `Agent` tool's `tool_execution_end` carries
//     `result.details = { agentId, status: 'background' | 'queued', … }`
//     (AgentDetails from our pi-subagents fork).
//  2. Completion: the extension's follow-up nudge arrives as a custom message
//     (`role: 'custom'`, `customType: 'subagent-notification'`) whose
//     `details` is a NotificationDetails `{ id, status, resultPreview, others? }`.
//     Additionally, `get_subagent_result`'s tool_execution_end carries the same
//     terminal status in its details — covering the case where the parent
//     consumes the result directly (which SUPPRESSES the notification nudge).

export interface AsyncAgentLaunch {
  taskId: string;
  description: string;
}

export interface TaskCompletion {
  taskId: string;
  status: 'completed' | 'failed';
  result?: string;
}

export interface TaskStartedEvent {
  type: 'task_started';
  task_id: string;
  description: string;
}

export interface TaskProgressEvent {
  type: 'task_progress';
  task_id: string;
  data: string;
}

export interface TaskNotificationEvent {
  type: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed';
  result?: string;
}

interface TaskState {
  launch: AsyncAgentLaunch;
  status: 'running' | 'completed' | 'failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// pi-subagents AgentRecord.status values that mean the agent is no longer
// running. 'steered' = wrapped up at the turn limit — it produced a result,
// so it resolves as completed, not failed.
const TERMINAL_STATUS: Record<string, 'completed' | 'failed'> = {
  completed: 'completed',
  steered: 'completed',
  aborted: 'failed',
  stopped: 'failed',
  error: 'failed',
};

function toolExecutionDetails(event: Record<string, unknown>): Record<string, unknown> | null {
  const result = event.result;
  if (!isRecord(result)) return null;
  const details = result.details;
  return isRecord(details) ? details : null;
}

function completionFromDetails(details: Record<string, unknown>): TaskCompletion | null {
  // NotificationDetails uses `id`; AgentDetails (tool results) uses `agentId`.
  const id = typeof details.id === 'string' ? details.id : details.agentId;
  if (typeof id !== 'string' || !id) return null;

  const status = typeof details.status === 'string' ? TERMINAL_STATUS[details.status] : undefined;
  if (!status) return null;

  const result = typeof details.resultPreview === 'string' ? details.resultPreview : undefined;
  return { taskId: id, status, ...(result ? { result } : {}) };
}

/** Background/queued subagent spawns, from an `Agent` tool_execution_end's structured details. */
export function extractSubagentLaunches(event: unknown): AsyncAgentLaunch[] {
  if (!isRecord(event) || event.type !== 'tool_execution_end') return [];

  const details = toolExecutionDetails(event);
  if (!details) return [];

  const agentId = details.agentId;
  if (typeof agentId !== 'string' || !agentId) return [];
  if (details.status !== 'background' && details.status !== 'queued') return [];

  const description =
    typeof details.description === 'string' && details.description ? details.description : 'Subagent';
  return [{ taskId: agentId, description }];
}

/**
 * Terminal subagent outcomes from a live Pi event. Handles the
 * subagent-notification custom message (including grouped `others`) and any
 * tool_execution_end whose details carry an agentId with a terminal status
 * (get_subagent_result consumption, foreground Agent completions — unknown
 * task ids are ignored by the tracker).
 */
export function extractSubagentCompletions(event: unknown): TaskCompletion[] {
  if (!isRecord(event)) return [];

  // Both message_start and message_end fire for custom messages; the tracker's
  // recordNotification is idempotent so processing both is harmless.
  if (event.type === 'message_start' || event.type === 'message_end') {
    const message = event.message;
    if (!isRecord(message) || message.role !== 'custom' || message.customType !== 'subagent-notification') return [];

    const details = message.details;
    if (!isRecord(details)) return [];

    const completions: TaskCompletion[] = [];
    const first = completionFromDetails(details);
    if (first) completions.push(first);

    if (Array.isArray(details.others)) {
      for (const other of details.others) {
        if (!isRecord(other)) continue;
        const completion = completionFromDetails(other);
        if (completion) completions.push(completion);
      }
    }
    return completions;
  }

  if (event.type === 'tool_execution_end') {
    const details = toolExecutionDetails(event);
    if (!details) return [];
    const completion = completionFromDetails(details);
    return completion ? [completion] : [];
  }

  return [];
}

export class AsyncTaskTracker {
  private tasks = new Map<string, TaskState>();

  recordLaunch(launch: AsyncAgentLaunch): TaskStartedEvent | null {
    if (this.tasks.has(launch.taskId)) return null;
    this.tasks.set(launch.taskId, { launch, status: 'running' });
    return {
      type: 'task_started',
      task_id: launch.taskId,
      description: launch.description,
    };
  }

  recordNotification(completion: TaskCompletion): TaskNotificationEvent | null {
    const task = this.tasks.get(completion.taskId);
    if (!task || task.status !== 'running') return null;

    task.status = completion.status;
    return {
      type: 'task_notification',
      task_id: completion.taskId,
      status: completion.status,
      ...(completion.result ? { result: completion.result } : {}),
    };
  }

  hasPending(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') return true;
    }
    return false;
  }
}
