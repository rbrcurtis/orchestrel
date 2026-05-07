import { memo, useState, useMemo, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { Copy, Check } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolUseBlock } from './ToolUseBlock';
import { BashToolBlock } from './BashToolBlock';
import { ScrollArea, ScrollBar } from '~/components/ui/scroll-area';
import type { ConversationEntry, ContentBlock, TurnResult } from '~/lib/message-accumulator';

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
  costUsd: number;
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
      total += usage.costUsd;
      continue;
    }
    total +=
      (usage.inputTokens * p.input +
        usage.outputTokens * p.output) /
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
          <pre className="bg-elevated rounded px-3 py-2 text-xs my-2 max-w-full whitespace-pre-wrap break-all overflow-hidden">
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
      <ScrollArea className="my-2">
        <table className="text-xs border-collapse">{children}</table>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
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
      className="self-start shrink-0 p-1 rounded -translate-x-0.5 text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function CopyableRow({ children, copyText }: { children: React.ReactNode; copyText: string }) {
  return (
    <div className="flex items-start gap-1.5 min-w-0 max-w-full overflow-hidden">
      <div className="flex-1 min-w-0">{children}</div>
      <CopyButton text={copyText} />
    </div>
  );
}

// --- Thinking block (always visible, muted) ---


function ThinkingBlock({ thinking }: { thinking: string }) {
  return (
    <div className="text-xs text-muted-foreground min-w-0 overflow-hidden">
      <div className="whitespace-pre-wrap break-words pl-3 border-l border-border min-w-0">{thinking}</div>
    </div>
  );
}

// --- Props ---

type Props = {
  entry: ConversationEntry;
  index: number;
  accentColor?: string | null;
};

const ENTRY_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatEntryTime(timestamp?: number): string | null {
  if (!timestamp) return null;
  return ENTRY_TIME_FORMATTER.format(new Date(timestamp));
}

export const MessageBlock = memo(observer(function MessageBlock({ entry, index: _index, accentColor }: Props) {
  switch (entry.kind) {
    case 'blocks':
      return <BlocksEntry blocks={entry.blocks} accentColor={accentColor} />;
    case 'result':
      return <TurnEndBlock data={entry.data} timestamp={entry.timestamp} />;
    case 'tool_activity':
      return (
        <div className="py-1 min-w-0 overflow-hidden">
          <ToolUseBlock
            name={entry.data.name}
            input={entry.data.input as Record<string, unknown>}
            output={entry.data.result}
          />
        </div>
      );
    case 'user':
      return <UserBlock content={entry.content} accentColor={accentColor} />;
    case 'error':
      return (
        <div className="text-xs text-destructive py-1 min-w-0 overflow-hidden">
          Error: {entry.message}
        </div>
      );
    case 'compact': {
      const time = formatEntryTime(entry.timestamp);
      return (
        <div className="flex items-center gap-2 my-2 text-[11px] text-muted-foreground min-w-0 overflow-hidden">
          <div className="flex-1 border-t border-neon-amber/30 shrink min-w-2" />
          <span className="text-neon-amber shrink-0">{entry.label ?? 'Context compacted'}{time ? ` · ${time}` : ''}</span>
          <div className="flex-1 border-t border-neon-amber/30 shrink min-w-2" />
        </div>
      );
    }
    case 'system':
      return entry.subtype === 'init' ? (
        <div className="flex flex-col items-center gap-1 my-2 text-[11px] text-muted-foreground min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 w-full min-w-0">
            <div className="flex-1 border-t border-border shrink min-w-2" />
            <span className="shrink-0">
              Session started · {entry.model ?? 'unknown'}
              {formatEntryTime(entry.timestamp) ? ` · ${formatEntryTime(entry.timestamp)}` : ''}
            </span>
            <div className="flex-1 border-t border-border shrink min-w-2" />
          </div>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground py-1 min-w-0 overflow-hidden">
          {entry.subtype}
        </div>
      );
    default:
      return null;
  }
}));

// --- Blocks entry: renders each ContentBlock ---

function BlocksEntry({ blocks, accentColor }: { blocks: ContentBlock[]; accentColor?: string | null }) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === 'text') {
          return <TextBlock key={i} content={block.content} accentColor={accentColor} />;
        }
        if (block.type === 'thinking') {
          return <ThinkingBlock key={i} thinking={block.content} />;
        }
        if (block.type === 'tool_use') {
          let input: Record<string, unknown> = {};
          if (block.input) {
            try {
              input = JSON.parse(block.input) as Record<string, unknown>;
            } catch {
              input = {};
            }
          }
          const name = block.name ?? '';
          if (name === 'Bash' || name === 'bash') {
            const command = typeof input['command'] === 'string' ? input['command'] : '';
            const description = typeof input['description'] === 'string' ? input['description'] : undefined;
            return (
              <BashToolBlock
                key={i}
                command={command}
                description={description}
                output={undefined}
                isRunning={!block.complete}
              />
            );
          }
          return (
            <div key={i} className="py-1 min-w-0 overflow-hidden">
              <ToolUseBlock name={name} input={input} output={undefined} />
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

// --- Text block ---

function TextBlock({ content, accentColor }: { content: string; accentColor?: string | null }) {
  const linkColor = accentColor || 'var(--neon-cyan)';
  return (
    <div className="group py-2 min-w-0 max-w-full overflow-hidden">
      <CopyableRow copyText={content}>
        <div className="text-sm text-foreground min-w-0 break-words">
          <Markdown text={content} linkColor={linkColor} />
        </div>
      </CopyableRow>
    </div>
  );
}

// --- Turn end block ---

function TurnEndBlock({ data, timestamp }: { data: TurnResult; timestamp?: number }) {
  const isSuccess = data.subtype === 'success' || data.subtype === 'error_max_turns';
  const cost = data.modelUsage
    ? calcCostFromModelUsage(data.modelUsage, data.costUsd)
    : data.costUsd;
  const durationSec = data.durationMs != null ? (data.durationMs / 1000).toFixed(1) : null;

  return (
    <div className="flex flex-col items-center gap-1 my-2 text-[11px] text-muted-foreground min-w-0 overflow-hidden">
      <div className="flex items-center gap-2 w-full min-w-0">
        <div className="flex-1 border-t border-border shrink min-w-2" />
        <span className={`shrink-0 ${isSuccess ? '' : 'text-destructive'}`}>
          {isSuccess ? 'Turn complete' : `Error: ${data.subtype ?? 'unknown'}`}
          {formatEntryTime(timestamp) ? ` · ${formatEntryTime(timestamp)}` : ''}
          {cost != null && ` · $${cost.toFixed(4)}`}
          {durationSec != null && ` · ${durationSec}s`}
        </span>
        <div className="flex-1 border-t border-border shrink min-w-2" />
      </div>
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

function UserBlock({ content, accentColor }: { content: string; accentColor?: string | null }) {
  if (!content) return null;

  if (content.includes('<command-name>') || content.includes('<local-command-') || content.includes('<system-reminder>'))
    return null;

  if (content.startsWith('# ') && (content.includes('## Instructions') || content.includes('## Arguments'))) {
    return <div className="text-xs text-muted-foreground py-0.5 italic">skill loaded</div>;
  }

  // Extract file attachments from prompt prefix
  const fileMatch = content.match(
    /^I've attached the following files for you to review\. Use the Read tool to read them:\n((?:- .+\n)+)\n([\s\S]*)$/,
  );
  let attachedFiles: { name: string; mimeType: string }[] = [];
  let displayText = content;

  if (fileMatch) {
    const fileLines = fileMatch[1].trim().split('\n');
    attachedFiles = fileLines.map((line) => {
      const m = line.match(/^- .+\((.+?), (.+?)\)$/);
      return m ? { name: m[1], mimeType: m[2] } : { name: line, mimeType: '' };
    });
    displayText = fileMatch[2] || '';
  }

  const accentVar = accentColor || 'var(--neon-cyan)';

  return (
    <div className="flex justify-end my-2 min-w-0">
      <div
        className="group text-sm text-foreground bg-elevated rounded-lg pl-3 pr-1 py-2 max-w-[85%] border-l-2 min-w-0 overflow-hidden"
        style={{ borderLeftColor: accentVar }}
      >
        <CopyableRow copyText={displayText || content}>
          <div className="min-w-0">
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
        </CopyableRow>
      </div>
    </div>
  );
}
