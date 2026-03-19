import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '~/components/ui/collapsible';
import { Badge } from '~/components/ui/badge';
import { ScrollArea } from '~/components/ui/scroll-area';

type Props = {
  name: string;
  input: Record<string, unknown>;
  output?: string;
};

const toolVariants: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  Bash: 'default',
  Read: 'secondary',
  Edit: 'secondary',
  Write: 'secondary',
  Grep: 'outline',
  Glob: 'outline',
};

export function ToolUseBlock({ name, input, output }: Props) {
  const [expanded, setExpanded] = useState(false);
  const variant = toolVariants[name] ?? 'secondary';

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="rounded border border-border overflow-hidden my-1"
    >
      <CollapsibleTrigger className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs font-medium bg-muted hover:bg-hover transition-colors">
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Badge variant={variant} className="text-xs font-mono">
          {name}
        </Badge>
        {!expanded && (
          <span className="text-[11px] font-mono text-muted-foreground truncate min-w-0">
            {summarizeInput(name, input)}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="p-2 space-y-2 bg-muted">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Input</div>
            <ScrollArea className="max-h-60">
              <pre className="text-xs font-mono whitespace-pre-wrap break-all text-foreground">
                {formatInput(input)}
              </pre>
            </ScrollArea>
          </div>
          {output != null && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Output</div>
              <ScrollArea className="max-h-60">
                <pre className="text-xs font-mono whitespace-pre-wrap break-all text-foreground">{output}</pre>
              </ScrollArea>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Bash': {
      const cmd = str('command');
      return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
    }
    case 'Read':
    case 'Write':
      return shortPath(str('file_path'));
    case 'Edit':
      return shortPath(str('file_path'));
    case 'Grep':
      return str('pattern');
    case 'Glob':
      return str('pattern');
    case 'WebFetch':
      return str('url');
    case 'Agent':
      return str('description');
    default: {
      // Fall back to first string value
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      return first ? (first.length > 60 ? first.slice(0, 57) + '...' : first) : '';
    }
  }
}

function shortPath(p: string): string {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : p;
}

function formatInput(input: Record<string, unknown>): string {
  // For simple single-field inputs like { command: "ls" }, just show the value
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input[keys[0]] === 'string') {
    return input[keys[0]] as string;
  }
  return JSON.stringify(input, null, 2);
}
