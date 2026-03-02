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
    <Collapsible open={expanded} onOpenChange={setExpanded} className="rounded border border-gray-200 dark:border-gray-700 overflow-hidden my-1">
      <CollapsibleTrigger className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs font-medium bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Badge variant={variant} className="text-xs font-mono">
          {name}
        </Badge>
        <span className="ml-auto text-[10px] opacity-60">
          {expanded ? 'collapse' : 'expand'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="p-2 space-y-2 bg-gray-50 dark:bg-gray-800/50">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Input</div>
            <ScrollArea className="max-h-60">
              <pre className="text-xs font-mono whitespace-pre-wrap break-all text-gray-700 dark:text-gray-300">
                {formatInput(input)}
              </pre>
            </ScrollArea>
          </div>
          {output != null && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Output</div>
              <ScrollArea className="max-h-60">
                <pre className="text-xs font-mono whitespace-pre-wrap break-all text-gray-700 dark:text-gray-300">
                  {output}
                </pre>
              </ScrollArea>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function formatInput(input: Record<string, unknown>): string {
  // For simple single-field inputs like { command: "ls" }, just show the value
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input[keys[0]] === 'string') {
    return input[keys[0]] as string;
  }
  return JSON.stringify(input, null, 2);
}
