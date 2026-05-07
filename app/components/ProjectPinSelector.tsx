import { observer } from 'mobx-react-lite';
import { useProjectStore } from '~/stores/context';
import type { PinTarget } from '~/lib/resolve-pin';

type Props = {
  onSelect: (projectId: PinTarget) => void;
};

export const ProjectPinSelector = observer(function ProjectPinSelector({ onSelect }: Props) {
  const projectStore = useProjectStore();
  const projects = projectStore.active;

  if (projects.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No projects configured
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="flex flex-col gap-1 w-full max-w-48">
        <span className="text-xs text-muted-foreground font-medium px-3 mb-1">Pin to project</span>
        <button
          className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-accent text-sm text-left transition-colors"
          onClick={() => onSelect('all')}
        >
          <span
            className="size-2.5 rounded-full shrink-0"
            style={{
              background: 'conic-gradient(from 0deg, #ef4444, #f59e0b, #22c55e, #3b82f6, #a855f7, #ef4444)',
            }}
          />
          <span className="truncate">All Projects</span>
        </button>
        {projects.map((p) => (
          <button
            key={p.id}
            className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-accent text-sm text-left transition-colors"
            onClick={() => onSelect(p.id)}
          >
            {p.color && <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: p.color }} />}
            <span className="truncate">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
});
