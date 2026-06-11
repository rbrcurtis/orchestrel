/* oxlint-disable orchestrel/log-before-early-return -- pure parser/tracker guard returns are intentional */
export interface ToolUseMetadata {
  name: string;
  description: string;
}

export interface BackgroundTaskLaunch {
  taskId: string;
  toolUseId: string;
  toolName?: string;
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
  launch: BackgroundTaskLaunch;
  status: 'running' | 'completed' | 'failed';
}

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'stopped', 'killed']);

function firstMatch(text: string, re: RegExp): string | undefined {
  const match = re.exec(text);
  return match?.[1]?.trim();
}

function tagValue(content: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  return firstMatch(content, re);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((block) => {
      if (!isRecord(block)) return '';
      const text = block.text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function outputFileFromLaunchText(text: string): string | undefined {
  const outputFile = firstMatch(text, /output_file:\s*(\S+)/)
    ?? firstMatch(text, /Output is being written to:\s*(\S+)/);
  return outputFile?.replace(/[.,;:]$/, '');
}

function descriptionFromInput(input: unknown, fallback: string): string {
  if (!isRecord(input)) return fallback;
  const description = input.description;
  if (typeof description === 'string' && description.trim()) return description.trim();
  return fallback;
}

function taskIdFromToolUseResult(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;

  const backgroundTaskId = result.backgroundTaskId;
  if (typeof backgroundTaskId === 'string' && backgroundTaskId.trim()) return backgroundTaskId.trim();

  const taskId = result.taskId;
  if (typeof taskId === 'string' && taskId.trim()) return taskId.trim();

  return undefined;
}

function taskIdFromEvent(event: Record<string, unknown>): string | undefined {
  return taskIdFromToolUseResult(event.toolUseResult) ?? taskIdFromToolUseResult(event.tool_use_result);
}

export function parseAsyncAgentLaunch(
  text: string,
  toolUseId: string,
  description: string,
): BackgroundTaskLaunch | null {
  if (!text.includes('Async agent launched successfully.')) return null;

  const taskId = firstMatch(text, /agentId:\s*([^\s(]+)/);
  if (!taskId) return null;

  const outputFile = outputFileFromLaunchText(text);
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
  if (!taskId || !status || !TERMINAL_TASK_STATUSES.has(status)) return null;

  const toolUseId = tagValue(content, 'tool-use-id');
  const outputFile = tagValue(content, 'output-file');
  const summary = tagValue(content, 'summary');
  const result = tagValue(content, 'result') ?? tagValue(content, 'event') ?? summary;

  return {
    taskId,
    status: status === 'completed' ? 'completed' : 'failed',
    ...(toolUseId ? { toolUseId } : {}),
    ...(outputFile ? { outputFile } : {}),
    ...(summary ? { summary } : {}),
    ...(result ? { result } : {}),
  };
}

export function parseSdkTaskNotification(event: unknown): TaskNotification | null {
  if (!isRecord(event) || event.type !== 'system' || event.subtype !== 'task_notification') return null;

  const taskId = event.task_id;
  if (typeof taskId !== 'string' || !taskId.trim()) return null;

  const status = event.status;
  if (typeof status !== 'string' || !TERMINAL_TASK_STATUSES.has(status)) return null;

  const toolUseId = event.tool_use_id;
  const outputFile = event.output_file;
  const summary = event.summary;

  return {
    taskId: taskId.trim(),
    status: status === 'completed' ? 'completed' : 'failed',
    ...(typeof toolUseId === 'string' && toolUseId.trim() ? { toolUseId: toolUseId.trim() } : {}),
    ...(typeof outputFile === 'string' && outputFile.trim() ? { outputFile: outputFile.trim() } : {}),
    ...(typeof summary === 'string' && summary.trim() ? { summary: summary.trim(), result: summary.trim() } : {}),
  };
}

export function extractBackgroundTaskLaunches(
  event: unknown,
  toolUses: Map<string, ToolUseMetadata>,
): BackgroundTaskLaunch[] {
  if (!isRecord(event) || event.type !== 'user') return [];

  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];

  const launches: BackgroundTaskLaunch[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'tool_result') continue;

    const toolUseId = block.tool_use_id;
    if (typeof toolUseId !== 'string') continue;

    const tool = toolUses.get(toolUseId);
    if (!tool) continue;

    const text = textFromToolResultContent(block.content);
    const taskId = taskIdFromEvent(event);
    if (taskId) {
      const outputFile = outputFileFromLaunchText(text);
      launches.push({
        taskId,
        toolUseId,
        toolName: tool.name,
        description: tool.description,
        ...(outputFile ? { outputFile } : {}),
      });
      continue;
    }

    if (tool.name !== 'Agent' && tool.name !== 'Task') continue;

    const launch = parseAsyncAgentLaunch(text, toolUseId, tool.description);
    if (launch) launches.push(launch);
  }

  return launches;
}

export function toolUseMetadataFromEvent(event: unknown): Array<[string, ToolUseMetadata]> {
  if (!isRecord(event) || event.type !== 'assistant') return [];

  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];

  const metadata: Array<[string, ToolUseMetadata]> = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;

    const toolUseId = block.id;
    const name = block.name;
    if (typeof toolUseId !== 'string' || typeof name !== 'string') continue;

    metadata.push([
      toolUseId,
      {
        name,
        description: descriptionFromInput(block.input, `${name} background task`),
      },
    ]);
  }

  return metadata;
}

export class AsyncTaskTracker {
  private tasks = new Map<string, TaskState>();
  private failedMonitor = false;

  recordLaunch(launch: BackgroundTaskLaunch): TaskStartedEvent | null {
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
    if (task.launch.toolName === 'Monitor' && notification.status === 'failed') this.failedMonitor = true;
    return {
      type: 'task_notification',
      task_id: notification.taskId,
      status: notification.status,
      ...(notification.result ? { result: notification.result } : {}),
    };
  }

  hasFailedMonitor(): boolean {
    return this.failedMonitor;
  }

  hasPending(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') return true;
    }
    return false;
  }
}
