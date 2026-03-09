import { useState, useMemo, useCallback, type ComponentProps } from 'react';
import { ChevronRight, ChevronDown, Copy, Check } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolUseBlock } from './ToolUseBlock';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '~/components/ui/collapsible';

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

// Correct per-model pricing in USD per million tokens
const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-opus-4-6':   { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-haiku-4-5':  { input: 1, output: 5,  cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-3-5':  { input: 0.8, output: 4, cacheWrite: 1,   cacheRead: 0.08 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-3-7': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-3-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

function lookupPricing(model: string) {
  // exact match first, then prefix match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const key of Object.keys(MODEL_PRICING)) {
    if (model.startsWith(key)) return MODEL_PRICING[key];
  }
  return null;
}

type ModelUsageEntry = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
};

function calcCostFromModelUsage(
  modelUsage: Record<string, ModelUsageEntry>,
  fallback: number | undefined
): number | undefined {
  let total = 0;
  let allKnown = true;
  for (const [model, usage] of Object.entries(modelUsage)) {
    const p = lookupPricing(model);
    if (!p) { allKnown = false; total += usage.costUSD; continue; }
    total +=
      (usage.inputTokens * p.input +
       usage.outputTokens * p.output +
       (usage.cacheCreationInputTokens ?? 0) * p.cacheWrite +
       (usage.cacheReadInputTokens ?? 0) * p.cacheRead) /
      1_000_000;
  }
  if (!allKnown && fallback != null) return fallback; // unknown model, trust SDK
  return Object.keys(modelUsage).length ? total : fallback;
}

/** Linkify URLs within plain text children (for code blocks) */
function linkifyChildren(children: React.ReactNode, color: string): React.ReactNode {
  if (typeof children === 'string') {
    const parts: React.ReactNode[] = [];
    let last = 0;
    for (const m of children.matchAll(URL_RE)) {
      const idx = m.index!;
      if (idx > last) parts.push(children.slice(last, idx));
      const url = m[0];
      parts.push(
        <a key={idx} href={url} target="_blank" rel="noopener noreferrer"
          className="underline hover:opacity-80" style={{ color }}>
          {url}
        </a>
      );
      last = idx + url.length;
    }
    if (parts.length === 0) return children;
    if (last < children.length) parts.push(children.slice(last));
    return parts;
  }
  return children;
}

/** Build react-markdown component overrides with accent-colored links */
function mdComponents(linkColor: string): Components {
  return {
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:opacity-80"
        style={{ color: linkColor }}
      >
        {children}
      </a>
    ),
    code: ({ className, children, ...rest }) => {
      const isBlock = className?.startsWith('language-');
      const linked = linkifyChildren(children, linkColor);
      if (isBlock) {
        return (
          <pre className="bg-elevated rounded px-3 py-2 overflow-x-auto text-xs my-2">
            <code className={className} {...rest}>{linked}</code>
          </pre>
        );
      }
      return (
        <code className="bg-elevated rounded px-1 py-0.5 text-xs" {...rest}>
          {linked}
        </code>
      );
    },
    pre: ({ children }) => <>{children}</>,
    ul: ({ children }) => <ul className="list-disc pl-5 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 space-y-0.5">{children}</ol>,
    li: ({ children }) => <li className="text-sm">{children}</li>,
    h1: ({ children }) => <h1 className="text-base font-bold mt-3 mb-1">{children}</h1>,
    h2: ({ children }) => <h2 className="text-sm font-bold mt-2 mb-1">{children}</h2>,
    h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-0.5">{children}</h3>,
    p: ({ children }) => <p className="text-sm my-1">{children}</p>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-border pl-3 text-muted-foreground italic my-1">
        {children}
      </blockquote>
    ),
    table: ({ children }) => (
      <div className="overflow-x-auto my-2">
        <table className="text-xs border-collapse">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>,
    td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
    hr: () => <hr className="border-border my-2" />,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  };
}

/** Render markdown text with accent-colored links */
function Markdown({ text, linkColor }: { text: string; linkColor: string }) {
  const components = useMemo(() => mdComponents(linkColor), [linkColor]);
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="absolute top-2.5 right-1 p-1 rounded text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

type Props = {
  message: Record<string, unknown>;
  toolOutputs: Map<string, string>;
  accentColor?: string | null;
};

export function MessageBlock({ message, toolOutputs, accentColor }: Props) {
  const type = message.type as string;

  if (type === 'assistant') {
    return <AssistantBlock message={message} toolOutputs={toolOutputs} accentColor={accentColor} />;
  }

  if (type === 'result') {
    return <ResultBlock message={message} />;
  }

  if (type === 'tool_progress') {
    return <ToolProgressBlock message={message} />;
  }

  if (type === 'system') {
    return <SystemBlock message={message} />;
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
  accentColor,
}: {
  message: Record<string, unknown>;
  toolOutputs: Map<string, string>;
  accentColor?: string | null;
}) {
  const inner = message.message as { content?: ContentBlock[] } | undefined;
  const content = inner?.content;
  if (!content || !Array.isArray(content)) return null;
  const linkColor = accentColor ? `var(--${accentColor})` : 'var(--neon-cyan)';

  const copyText = content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n\n');

  return (
    <div className="group relative space-y-2 py-2 min-w-0 max-w-full overflow-hidden">
      {copyText && <CopyButton text={copyText} />}
      {content.map((block, i) => {
        if (block.type === 'text' && block.text) {
          return (
            <div key={i} className="text-sm text-foreground min-w-0 break-words">
              <Markdown text={block.text} linkColor={linkColor} />
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

// --- System message ---

function SystemBlock({ message }: { message: Record<string, unknown> }) {
  const subtype = message.subtype as string | undefined;

  if (subtype === 'init') {
    return (
      <div className="text-xs text-muted-foreground py-1">
        Session started (model: {String(message.model ?? 'unknown')})
      </div>
    );
  }

  if (subtype === 'compact_boundary') {
    const meta = message.compact_metadata as { pre_tokens?: number; trigger?: string } | undefined;
    return (
      <div className="flex items-center gap-2 my-2 text-[11px] text-muted-foreground">
        <div className="flex-1 border-t border-neon-amber/30" />
        <span className="text-neon-amber">
          Context compacted
          {meta?.pre_tokens != null && ` · ${Math.round(meta.pre_tokens / 1000)}k tokens`}
        </span>
        <div className="flex-1 border-t border-neon-amber/30" />
      </div>
    );
  }

  if (subtype === 'local_command_output') {
    const content = message.content as string | undefined;
    if (!content) return null;
    return (
      <div className="text-xs text-muted-foreground whitespace-pre-wrap py-1 pl-3 border-l-2 border-neon-violet/40">
        {content}
      </div>
    );
  }

  // Show any other system message as plain text
  const content = message.content as string | undefined;
  if (!content) return null;
  return (
    <div className="text-xs text-muted-foreground py-1">
      {content}
    </div>
  );
}

// --- Result message ---

function ResultBlock({ message }: { message: Record<string, unknown> }) {
  const subtype = message.subtype as string;
  const isSuccess = subtype === 'success' || subtype === 'error_max_turns';
  const sdkCost = message.total_cost_usd as number | undefined;
  const modelUsage = message.modelUsage as Record<string, ModelUsageEntry> | undefined;
  const cost = modelUsage ? calcCostFromModelUsage(modelUsage, sdkCost) : sdkCost;
  const durationMs = message.duration_ms as number | undefined;
  const durationSec = durationMs != null ? (durationMs / 1000).toFixed(1) : null;
  const rawTs = (message.ts ?? message._mtime) as string | undefined;
  const finishedAt = rawTs
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(rawTs))
    : null;

  const errors = Array.isArray(message.errors) ? (message.errors as string[]) : [];

  return (
    <div className="flex flex-col items-center gap-1 my-2 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-2 w-full">
        <div className="flex-1 border-t border-border" />
        <span className={isSuccess ? '' : 'text-destructive'}>
          {isSuccess ? 'Turn complete' : `Error: ${subtype}`}
          {cost != null && ` · $${cost.toFixed(4)}`}
          {durationSec != null && ` · ${durationSec}s`}
          {finishedAt != null && ` · ${finishedAt}`}
        </span>
        <div className="flex-1 border-t border-border" />
      </div>
      {errors.length > 0 && (
        <div className="text-destructive/80 text-[10px] max-w-md text-center">
          {errors.join(' · ')}
        </div>
      )}
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

  let text: string | null = null;
  if (typeof inner.content === 'string') {
    text = inner.content;
  } else if (Array.isArray(inner.content)) {
    const parts = (inner.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!);
    if (parts.length > 0) text = parts.join('\n');
  }

  if (!text) return null;

  if (text.includes('<command-name>') || text.includes('<local-command-') || text.includes('<system-reminder>')) {
    return null;
  }

  if (text.startsWith('# ') && (text.includes('## Instructions') || text.includes('## Arguments'))) {
    return (
      <div className="text-xs text-muted-foreground py-0.5 italic">
        skill loaded
      </div>
    );
  }

  // Extract file attachments from prompt prefix
  const fileMatch = text.match(/^I've attached the following files for you to review\. Use the Read tool to read them:\n((?:- .+\n)+)\n([\s\S]*)$/);
  let attachedFiles: { name: string; mimeType: string }[] = [];
  let displayText = text;

  if (fileMatch) {
    const fileLines = fileMatch[1].trim().split('\n');
    attachedFiles = fileLines.map((line) => {
      const m = line.match(/^- .+\((.+?), (.+?)\)$/);
      return m ? { name: m[1], mimeType: m[2] } : { name: line, mimeType: '' };
    });
    displayText = fileMatch[2] || '';
  }

  const accentVar = accentColor ? `var(--${accentColor})` : 'var(--neon-cyan)';

  // Highlight /slash-commands (only when preceded by whitespace or start of string)
  function renderWithSlashCommands(t: string) {
    const re = /(?<![^\s])\/[a-zA-Z][a-zA-Z0-9-]*/g;
    const result: React.ReactNode[] = [];
    let last = 0;
    for (const m of t.matchAll(re)) {
      const idx = m.index!;
      if (idx > last) result.push(t.slice(last, idx));
      result.push(<span key={idx} className="font-mono font-semibold text-neon-cyan">{m[0]}</span>);
      last = idx + m[0].length;
    }
    if (result.length === 0) return t;
    if (last < t.length) result.push(t.slice(last));
    return result;
  }

  return (
    <div className="flex justify-end my-2">
      <div
        className="group relative text-sm text-foreground bg-elevated rounded-lg pl-3 pr-8 py-2 max-w-[85%] border-l-2"
        style={{ borderLeftColor: accentVar }}
      >
        <CopyButton text={displayText || text} />
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachedFiles.map((f, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted text-xs text-muted-foreground border border-border"
              >
                {f.name}
              </span>
            ))}
          </div>
        )}
        {displayText && <span className="whitespace-pre-wrap">{renderWithSlashCommands(displayText)}</span>}
      </div>
    </div>
  );
}
