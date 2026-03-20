import { useState, useMemo, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { Copy, Check } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolUseBlock } from './ToolUseBlock';
import { BashToolBlock } from './BashToolBlock';
import type { AgentMessage } from '../../src/shared/ws-protocol';

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

// Correct per-model pricing in USD per million tokens
const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-3-7': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-3-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

function lookupPricing(model: string) {
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
  fallback: number | undefined,
): number | undefined {
  let total = 0;
  let allKnown = true;
  for (const [model, usage] of Object.entries(modelUsage)) {
    const p = lookupPricing(model);
    if (!p) {
      allKnown = false;
      total += usage.costUSD;
      continue;
    }
    total +=
      (usage.inputTokens * p.input +
        usage.outputTokens * p.output +
        (usage.cacheCreationInputTokens ?? 0) * p.cacheWrite +
        (usage.cacheReadInputTokens ?? 0) * p.cacheRead) /
      1_000_000;
  }
  if (!allKnown && fallback != null) return fallback;
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
        <a
          key={idx}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:opacity-80"
          style={{ color }}
        >
          {url}
        </a>,
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
          <pre className="bg-elevated rounded px-3 py-2 overflow-x-auto text-xs my-2 max-w-full">
            <code className={className} {...rest}>
              {linked}
            </code>
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
      <blockquote className="border-l-2 border-border pl-3 text-muted-foreground italic my-1">{children}</blockquote>
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

// --- Thinking block (always visible, muted) ---

function ThinkingBlock({ thinking }: { thinking: string }) {
  return (
    <div className="text-xs text-muted-foreground min-w-0 overflow-x-auto">
      <div className="whitespace-pre-wrap break-words pl-3 border-l border-border min-w-0">{thinking}</div>
    </div>
  );
}

// --- Props ---

type Props = {
  message: AgentMessage & { id: string };
  toolOutputs: Map<string, string>;
  accentColor?: string | null;
};

export const MessageBlock = observer(function MessageBlock({ message, toolOutputs, accentColor }: Props) {
  switch (message.type) {
    case 'text':
      return <TextBlock message={message} accentColor={accentColor} />;
    case 'tool_call':
      return <ToolCallBlock message={message} toolOutputs={toolOutputs} />;
    case 'tool_result':
      return null; // consumed by toolOutputs map
    case 'tool_progress':
      return <ToolProgressBlock message={message} />;
    case 'thinking':
      return <ThinkingBlock thinking={message.content} />;
    case 'system':
      return <SystemBlock message={message} />;
    case 'turn_end':
      return <TurnEndBlock message={message} />;
    case 'user':
      return <UserBlock message={message} accentColor={accentColor} />;
    default:
      return null;
  }
});

// --- Text block ---

const TextBlock = observer(function TextBlock({
  message,
  accentColor,
}: {
  message: AgentMessage;
  accentColor?: string | null;
}) {
  const linkColor = accentColor ? `var(--${accentColor})` : 'var(--neon-cyan)';
  return (
    <div className="group relative space-y-2 py-2 min-w-0 max-w-full overflow-x-auto">
      <CopyButton text={message.content} />
      <div className="text-sm text-foreground min-w-0 break-words">
        <Markdown text={message.content} linkColor={linkColor} />
      </div>
    </div>
  );
});

// --- Tool call block ---

function ToolCallBlock({ message, toolOutputs }: { message: AgentMessage; toolOutputs: Map<string, string> }) {
  if (!message.toolCall) return null;
  const tc = message.toolCall;
  const output = tc.id ? toolOutputs.get(tc.id) : undefined;
  const isRunning = !output && !toolOutputs.has(tc.id ?? '');

  // Bash tools get a terminal-style renderer
  if (tc.name === 'Bash' || tc.name === 'bash') {
    const command = typeof tc.params?.command === 'string' ? tc.params.command : '';
    const description = typeof tc.params?.description === 'string' ? tc.params.description : undefined;
    return (
      <BashToolBlock
        command={command}
        description={description}
        streamingOutput={tc.streamingOutput}
        output={output}
        isRunning={isRunning}
      />
    );
  }

  return (
    <div className="py-1 min-w-0 overflow-x-auto">
      <ToolUseBlock name={tc.name} input={tc.params ?? {}} output={output} />
    </div>
  );
}

// --- Tool progress block ---

function ToolProgressBlock({ message }: { message: AgentMessage }) {
  const elapsed = message.meta?.elapsedSeconds as number | undefined;
  return (
    <div className="text-xs text-muted-foreground py-0.5 flex items-center gap-1.5 min-w-0 overflow-x-auto">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
      <span className="min-w-0 truncate">
        {message.content} {elapsed != null && `(${elapsed.toFixed(0)}s)`}
      </span>
    </div>
  );
}

// --- System block ---

function SystemBlock({ message }: { message: AgentMessage }) {
  const subtype = message.meta?.subtype as string | undefined;

  if (subtype === 'init') {
    return (
      <div className="text-xs text-muted-foreground py-1 min-w-0 overflow-x-auto">
        Session started (model: {String(message.meta?.model ?? 'unknown')})
      </div>
    );
  }

  if (subtype === 'retry') {
    const attempt = message.meta?.attempt as number | undefined;
    const retryMsg = String(message.meta?.message ?? 'Retrying...');
    return (
      <div className="text-xs text-neon-amber py-1 min-w-0 overflow-x-auto">
        {retryMsg}
        {attempt != null && ` (attempt ${attempt})`}
      </div>
    );
  }

  if (subtype === 'compact_boundary') {
    const meta = message.meta?.compactMetadata as { pre_tokens?: number } | undefined;
    return (
      <div className="flex items-center gap-2 my-2 text-[11px] text-muted-foreground min-w-0 overflow-x-auto">
        <div className="flex-1 border-t border-neon-amber/30 shrink min-w-2" />
        <span className="text-neon-amber shrink-0">
          Context compacted
          {meta?.pre_tokens != null && ` · ${Math.round(meta.pre_tokens / 1000)}k tokens`}
        </span>
        <div className="flex-1 border-t border-neon-amber/30 shrink min-w-2" />
      </div>
    );
  }

  if (subtype === 'local_command_output' && message.content) {
    return (
      <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words py-1 pl-3 border-l-2 border-neon-violet/40 min-w-0 overflow-x-auto">
        {message.content}
      </div>
    );
  }

  if (!message.content) return null;
  return <div className="text-xs text-muted-foreground py-1 min-w-0 overflow-x-auto">{message.content}</div>;
}

// --- Turn end block ---

function TurnEndBlock({ message }: { message: AgentMessage }) {
  const subtype = message.meta?.subtype as string | undefined;
  const isSuccess = subtype === 'success' || subtype === 'error_max_turns';
  const sdkCost = message.meta?.totalCostUsd as number | undefined;
  const cost = message.modelUsage
    ? calcCostFromModelUsage(message.modelUsage as Record<string, ModelUsageEntry>, sdkCost)
    : sdkCost;
  const durationMs = message.meta?.durationMs as number | undefined;
  const durationSec = durationMs != null ? (durationMs / 1000).toFixed(1) : null;
  const finishedAt = message.timestamp
    ? new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(message.timestamp))
    : null;

  const errors = Array.isArray(message.meta?.errors) ? (message.meta!.errors as string[]) : [];

  return (
    <div className="flex flex-col items-center gap-1 my-2 text-[11px] text-muted-foreground min-w-0 overflow-x-auto">
      <div className="flex items-center gap-2 w-full min-w-0">
        <div className="flex-1 border-t border-border shrink min-w-2" />
        <span className={`shrink-0 ${isSuccess ? '' : 'text-destructive'}`}>
          {isSuccess ? 'Turn complete' : `Error: ${subtype ?? 'unknown'}`}
          {cost != null && ` · $${cost.toFixed(4)}`}
          {durationSec != null && ` · ${durationSec}s`}
          {finishedAt != null && ` · ${finishedAt}`}
        </span>
        <div className="flex-1 border-t border-border shrink min-w-2" />
      </div>
      {errors.length > 0 && (
        <div className="text-destructive/80 text-[10px] max-w-md text-center">{errors.join(' · ')}</div>
      )}
    </div>
  );
}

// --- User block ---

const SLASH_CMD_RE = /(?<![^\s])\/[a-zA-Z][a-zA-Z0-9-]*/g;

function renderWithSlashCommands(t: string): React.ReactNode {
  const result: React.ReactNode[] = [];
  let last = 0;
  for (const m of t.matchAll(SLASH_CMD_RE)) {
    const idx = m.index!;
    if (idx > last) result.push(t.slice(last, idx));
    result.push(
      <span key={idx} className="font-mono font-semibold text-neon-cyan">
        {m[0]}
      </span>,
    );
    last = idx + m[0].length;
  }
  if (result.length === 0) return t;
  if (last < t.length) result.push(t.slice(last));
  return result;
}

function UserBlock({ message, accentColor }: { message: AgentMessage; accentColor?: string | null }) {
  const text = message.content;
  if (!text) return null;

  if (text.includes('<command-name>') || text.includes('<local-command-') || text.includes('<system-reminder>'))
    return null;

  if (text.startsWith('# ') && (text.includes('## Instructions') || text.includes('## Arguments'))) {
    return <div className="text-xs text-muted-foreground py-0.5 italic">skill loaded</div>;
  }

  // Extract file attachments from prompt prefix
  const fileMatch = text.match(
    /^I've attached the following files for you to review\. Use the Read tool to read them:\n((?:- .+\n)+)\n([\s\S]*)$/,
  );
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

  return (
    <div className="flex justify-end my-2 min-w-0">
      <div
        className="group relative text-sm text-foreground bg-elevated rounded-lg pl-3 pr-8 py-2 max-w-[85%] border-l-2 min-w-0 overflow-x-auto"
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
        {displayText && <span className="whitespace-pre-wrap break-words">{renderWithSlashCommands(displayText)}</span>}
      </div>
    </div>
  );
}
