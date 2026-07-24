import { useRef, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '~/components/ui/collapsible';
import { ScrollArea } from '~/components/ui/scroll-area';

/** Strip ANSI escape codes (colors, cursor moves, etc.) */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[>=<]|\x1b\[[?]?[0-9;]*[hlsr]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

type Props = {
  command: string;
  description?: string;
  /** Streaming output while tool is running */
  streamingOutput?: string;
  /** Final output after tool completes */
  output?: string;
  /** Whether the tool is still running (no tool_result yet) */
  isRunning: boolean;
};

export const BashToolBlock = observer(function BashToolBlock({
  command,
  description,
  streamingOutput,
  output,
  isRunning,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const raw = output ?? streamingOutput ?? '';
  const displayOutput = stripAnsi(raw);
  const firstCommandLine = command.split(/\r?\n/, 1)[0];

  // Auto-scroll to bottom when output grows
  useEffect(() => {
    if (isRunning && bottomRef.current) {
      bottomRef.current.scrollIntoView({ block: 'end' });
    }
  }, [displayOutput, isRunning]);

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="my-1 rounded border border-border overflow-hidden font-mono text-xs min-w-0 max-w-full"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 bg-muted hover:bg-hover transition-colors text-left min-w-0">
        {expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        {isRunning && (
          <span className="inline-block size-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
        )}
        {expanded ? (
          description && <span className="text-muted-foreground truncate text-[11px] min-w-0">{description}</span>
        ) : (
          <>
            <span className="text-emerald-400 select-none shrink-0">$</span>
            <span className="text-foreground truncate min-w-0">{firstCommandLine}</span>
          </>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <ScrollArea className="bg-muted border-t border-border" viewportClassName="max-h-[400px]">
          <div className="px-3 py-2 min-w-0 max-w-full">
            <div className="flex gap-1.5 min-w-0">
              <span className="text-emerald-400 select-none shrink-0">$</span>
              <span className="text-foreground whitespace-pre-wrap break-all min-w-0">{command}</span>
            </div>

            {displayOutput && (
              <pre className="text-muted-foreground whitespace-pre-wrap break-all mt-1 leading-relaxed min-w-0 max-w-full">
                {displayOutput}
              </pre>
            )}

            {isRunning && <span className="inline-block w-1.5 h-3.5 bg-emerald-400/70 animate-pulse mt-0.5" />}

            <div ref={bottomRef} />
          </div>
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  );
});
