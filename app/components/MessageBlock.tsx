import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { ToolUseBlock } from './ToolUseBlock';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '~/components/ui/collapsible';
import { Alert, AlertTitle, AlertDescription } from '~/components/ui/alert';

type Props = {
  message: Record<string, unknown>;
  toolOutputs: Map<string, string>;
  accentColor?: string | null;
};

export function MessageBlock({ message, toolOutputs, accentColor }: Props) {
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
        <div className="text-xs text-muted-foreground py-1">
          Session started (model: {String((message as Record<string, unknown>).model ?? 'unknown')})
        </div>
      );
    }
    // Skip other system messages
    return null;
  }

  if (type === 'user') {
    return <UserBlock message={message} accentColor={accentColor} />;
  }

  // Skip other types
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
            <div key={i} className="text-sm text-foreground whitespace-pre-wrap">
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
    <Collapsible open={open} onOpenChange={setOpen} className="text-xs text-muted-foreground">
      <CollapsibleTrigger className="cursor-pointer hover:text-foreground flex items-center gap-1">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Thinking...
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 whitespace-pre-wrap pl-3 border-l border-border">
          {thinking}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// --- Result message ---

function ResultBlock({ message }: { message: Record<string, unknown> }) {
  const subtype = message.subtype as string;
  const isSuccess = subtype === 'success' || subtype === 'error_max_turns';
  const cost = message.total_cost_usd as number | undefined;
  const durationMs = message.duration_ms as number | undefined;
  const durationSec = durationMs != null ? (durationMs / 1000).toFixed(1) : null;

  return (
    <div className="flex items-center gap-2 my-2 text-[11px] text-muted-foreground">
      <div className="flex-1 border-t border-border" />
      <span className={isSuccess ? '' : 'text-destructive'}>
        {isSuccess ? 'Turn complete' : `Error: ${subtype}`}
        {cost != null && ` · $${cost.toFixed(4)}`}
        {durationSec != null && ` · ${durationSec}s`}
      </span>
      <div className="flex-1 border-t border-border" />
    </div>
  );
}

// --- Tool progress ---

function ToolProgressBlock({ message }: { message: Record<string, unknown> }) {
  const toolName = message.tool_name as string;
  const elapsed = message.elapsed_time_seconds as number;

  return (
    <div className="text-xs text-muted-foreground py-0.5 flex items-center gap-1.5">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
      {toolName} ({elapsed.toFixed(0)}s)
    </div>
  );
}

// --- User message ---

function UserBlock({ message, accentColor }: { message: Record<string, unknown>; accentColor?: string | null }) {
  const inner = message.message as { content?: unknown } | undefined;
  if (!inner?.content) return null;

  // Content can be a string or array of blocks
  let text: string | null = null;
  if (typeof inner.content === 'string') {
    text = inner.content;
  } else if (Array.isArray(inner.content)) {
    // Extract text from content blocks, skip tool_result blocks
    const parts = (inner.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!);
    if (parts.length > 0) text = parts.join('\n');
  }

  if (!text) return null;

  // Skip Claude Code internal messages (commands, system reminders, etc.)
  if (text.includes('<command-name>') || text.includes('<local-command-') || text.includes('<system-reminder>')) {
    return null;
  }

  const borderColor = accentColor ? `var(--${accentColor})` : 'var(--neon-cyan)';

  return (
    <div className="flex justify-end my-2">
      <div
        className="text-sm text-foreground whitespace-pre-wrap bg-elevated rounded-lg px-3 py-2 max-w-[85%] border-l-2"
        style={{ borderLeftColor: borderColor }}
      >
        {text}
      </div>
    </div>
  );
}
