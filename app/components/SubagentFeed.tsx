import { observer } from 'mobx-react-lite';
import type { SubagentState } from '~/lib/message-accumulator';

type Props = {
  subagents: Map<string, SubagentState>;
};

export const SubagentFeed = observer(function SubagentFeed({ subagents }: Props) {
  if (subagents.size === 0) return null;

  const entries = Array.from(subagents.entries());

  return (
    <div className="flex flex-col gap-1 px-3 py-1.5 bg-elevated border-t border-border shrink-0">
      {entries.map(([id, entry]) => {
        const isRunning = entry.status === 'running';
        return (
          <div
            key={id}
            className="flex items-center gap-2 text-[11px] transition-opacity duration-300"
            style={{ opacity: isRunning ? 1 : 0.4 }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{
                background: isRunning ? '#39ff14' : '#8a8a9e',
                boxShadow: isRunning ? '0 0 4px #39ff1466' : 'none',
              }}
            />
            <span className="text-foreground truncate min-w-0 flex-1">
              {entry.description.slice(0, 40)}
            </span>
            <span className="text-muted-foreground truncate min-w-0 shrink-0 max-w-[50%]">
              {entry.lastProgress}
            </span>
          </div>
        );
      })}
    </div>
  );
});
