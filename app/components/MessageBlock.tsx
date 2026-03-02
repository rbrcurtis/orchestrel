import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { ToolUseBlock } from './ToolUseBlock';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '~/components/ui/collapsible';
import { Alert, AlertTitle, AlertDescription } from '~/components/ui/alert';

type Props = {
  message: Record<string, unknown>;
  toolOutputs: Map<string, string>;
};

export function MessageBlock({ message, toolOutputs }: Props) {
  const type = message.type as string;

  if (type === 'assistant') {
    return <AssistantBlock message={message} toolOutputs={toolOutputs} />;
  }

  if (type === 'result') {
    return <ResultBlock message={message} />;
  }

  if (type === 'tool_progress') {
    return <ToolProgressBlock message={message} />;
  }

  if (type === 'system') {
    const subtype = message.subtype as string | undefined;
    if (subtype === 'init') {
      return (
        <div className="text-xs text-gray-400 dark:text-gray-500 py-1">
          Session started (model: {String((message as Record<string, unknown>).model ?? 'unknown')})
        </div>
      );
    }
    // Skip other system messages
    return null;
  }

  // Skip user messages and other types
  return null;
}

// --- Assistant message ---

type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  thinking?: string;
};

function AssistantBlock({
  message,
  toolOutputs,
}: {
  message: Record<string, unknown>;
  toolOutputs: Map<string, string>;
}) {
  const inner = message.message as { content?: ContentBlock[] } | undefined;
  const content = inner?.content;
  if (!content || !Array.isArray(content)) return null;

  return (
    <div className="space-y-2 py-2">
      {content.map((block, i) => {
        if (block.type === 'text' && block.text) {
          return (
            <div key={i} className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">
              {block.text}
            </div>
          );
        }
        if (block.type === 'tool_use' && block.name && block.input) {
          const output = block.id ? toolOutputs.get(block.id) : undefined;
          return (
            <ToolUseBlock
              key={block.id ?? i}
              name={block.name}
              input={block.input}
              output={output}
            />
          );
        }
        if (block.type === 'thinking' && block.thinking) {
          return <ThinkingBlock key={i} thinking={block.thinking} />;
        }
        return null;
      })}
    </div>
  );
}

// --- Thinking block (collapsible) ---

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="text-xs text-gray-400 dark:text-gray-500">
      <CollapsibleTrigger className="cursor-pointer hover:text-gray-600 dark:hover:text-gray-400 flex items-center gap-1">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Thinking...
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 whitespace-pre-wrap pl-3 border-l border-gray-200 dark:border-gray-700">
          {thinking}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// --- Result message ---

function ResultBlock({ message }: { message: Record<string, unknown> }) {
  const subtype = message.subtype as string;
  const isSuccess = subtype === 'success';
  const cost = message.total_cost_usd as number | undefined;
  const durationMs = message.duration_ms as number | undefined;
  const durationSec = durationMs != null ? (durationMs / 1000).toFixed(1) : null;

  return (
    <Alert variant={isSuccess ? 'default' : 'destructive'} className="my-2">
      <AlertTitle className="text-xs font-medium">
        {isSuccess ? 'Session completed' : `Session errored: ${subtype}`}
      </AlertTitle>
      <AlertDescription>
        <div className="flex gap-3 mt-1 text-[11px] opacity-80">
          {cost != null && <span>Cost: ${cost.toFixed(4)}</span>}
          {durationSec != null && <span>Duration: {durationSec}s</span>}
        </div>
      </AlertDescription>
    </Alert>
  );
}

// --- Tool progress ---

function ToolProgressBlock({ message }: { message: Record<string, unknown> }) {
  const toolName = message.tool_name as string;
  const elapsed = message.elapsed_time_seconds as number;

  return (
    <div className="text-xs text-gray-400 dark:text-gray-500 py-0.5 flex items-center gap-1.5">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
      {toolName} ({elapsed.toFixed(0)}s)
    </div>
  );
}
