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

export function parseAsyncAgentLaunch(_text: string, _toolUseId: string, _description: string): AsyncAgentLaunch | null {
  return null;
}

export function parseTaskNotification(_content: string): TaskNotification | null {
  return null;
}

export class AsyncTaskTracker {
  recordLaunch(_launch: AsyncAgentLaunch): TaskStartedEvent | null {
    return null;
  }

  recordNotification(_notification: TaskNotification): TaskNotificationEvent | null {
    return null;
  }

  hasPending(): boolean {
    return false;
  }
}
