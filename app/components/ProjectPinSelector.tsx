import { observer } from 'mobx-react-lite';
import { useProjectStore } from '~/stores/context';

type Props = {
  onSelect: (projectId: number) => void;
};

export const ProjectPinSelector = observer(function ProjectPinSelector({ onSelect }: Props) {
  const projectStore = useProjectStore();
  const projects = projectStore.all;

  if (projects.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No projects configured
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-4">
      <span className="text-xs text-muted-foreground font-medium">Pin to project</span>
      <div className="flex flex-col gap-1 w-full max-w-48">
        {projects.map((p) => (
          <button
            key={p.id}
            className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-accent text-sm text-left transition-colors"
            onClick={() => onSelect(p.id)}
          >
            {p.color && (
              <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: `var(--${p.color})` }} />
            )}
            <span className="truncate">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
});
