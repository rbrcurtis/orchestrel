/* oxlint-disable orchestrel/log-before-early-return -- pure parser/tracker guard returns are intentional */
export interface AsyncAgentLaunch {
  taskId: string;
  toolUseId: string;
  description: string;
  outputFile?: string;
}

export interface TaskNotification {
  taskId: string;
  toolUseId?: string;
  outputFile?: string;
  status: 'completed' | 'failed';
  summary?: string;
  result?: string;
}

export interface TaskStartedEvent {
  type: 'task_started';
  task_id: string;
  description: string;
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

function firstMatch(text: string, re: RegExp): string | undefined {
  const match = re.exec(text);
  return match?.[1]?.trim();
}

function tagValue(content: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  return firstMatch(content, re);
}

export function parseAsyncAgentLaunch(text: string, toolUseId: string, description: string): AsyncAgentLaunch | null {
  if (!text.includes('Async agent launched successfully.')) return null;

  const taskId = firstMatch(text, /agentId:\s*([^\s(]+)/);
  if (!taskId) return null;

  const outputFile = firstMatch(text, /output_file:\s*(\S+)/);
  return {
    taskId,
    toolUseId,
    description,
    ...(outputFile ? { outputFile } : {}),
  };
}

export function parseTaskNotification(content: string): TaskNotification | null {
  if (!content.includes('<task-notification>')) return null;

  const taskId = tagValue(content, 'task-id');
  const status = tagValue(content, 'status');
  if (!taskId || (status !== 'completed' && status !== 'failed')) return null;

  const toolUseId = tagValue(content, 'tool-use-id');
  const outputFile = tagValue(content, 'output-file');
  const summary = tagValue(content, 'summary');
  const result = tagValue(content, 'result');

  return {
    taskId,
    status,
    ...(toolUseId ? { toolUseId } : {}),
    ...(outputFile ? { outputFile } : {}),
    ...(summary ? { summary } : {}),
    ...(result ? { result } : {}),
  };
}

export function extractAsyncAgentLaunches(
  _event: unknown,
  _toolDescriptions: Map<string, string>,
): AsyncAgentLaunch[] {
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

  recordNotification(notification: TaskNotification): TaskNotificationEvent | null {
    const task = this.tasks.get(notification.taskId);
    if (!task || task.status !== 'running') return null;

    task.status = notification.status;
    return {
      type: 'task_notification',
      task_id: notification.taskId,
      status: notification.status,
      ...(notification.result ? { result: notification.result } : {}),
    };
  }

  hasPending(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') return true;
    }
    return false;
  }
}
