import { useRef, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { ScrollArea } from '~/components/ui/scroll-area';

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
  const displayOutput = output ?? streamingOutput ?? '';

  // Auto-scroll to bottom when output grows
  useEffect(() => {
    if (isRunning && bottomRef.current) {
      bottomRef.current.scrollIntoView({ block: 'end' });
    }
  }, [displayOutput, isRunning]);

  return (
    <div className="my-1 rounded border border-border overflow-hidden font-mono text-xs">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#1a1a2e] border-b border-border">
        {isRunning && (
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
        )}
        {description && (
          <span className="text-muted-foreground truncate text-[11px]">{description}</span>
        )}
      </div>

      {/* Terminal body */}
      <ScrollArea className="max-h-80">
        <div className="bg-[#0d0d1a] px-3 py-2 min-h-[2rem]">
          {/* Command prompt */}
          <div className="flex gap-1.5">
            <span className="text-emerald-400 select-none flex-shrink-0">$</span>
            <span className="text-foreground whitespace-pre-wrap break-all">{command}</span>
          </div>

          {/* Output */}
          {displayOutput && (
            <pre className="text-muted-foreground whitespace-pre-wrap break-all mt-1 leading-relaxed">
              {displayOutput}
            </pre>
          )}

          {/* Cursor indicator while running */}
          {isRunning && (
            <span className="inline-block w-1.5 h-3.5 bg-emerald-400/70 animate-pulse mt-0.5" />
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
});
