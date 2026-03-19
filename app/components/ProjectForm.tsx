import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useProjectStore, useConfigStore } from '~/stores/context';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '~/components/ui/select';
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Checkbox } from '~/components/ui/checkbox';
import { AlertCircle } from 'lucide-react';

const NEON_COLORS = [
  'neon-cyan',
  'neon-magenta',
  'neon-violet',
  'neon-amber',
  'neon-lime',
  'neon-coral',
  'neon-electric',
  'neon-plasma',
  'neon-ice',
  'neon-rose',
  'neon-teal',
  'neon-gold',
  'neon-indigo',
  'neon-acid',
  'neon-crimson',
  'neon-sky',
] as const;

const COLOR_LABELS: Record<string, string> = {
  'neon-cyan': 'Cyan',
  'neon-magenta': 'Magenta',
  'neon-violet': 'Violet',
  'neon-amber': 'Amber',
  'neon-lime': 'Lime',
  'neon-coral': 'Coral',
  'neon-electric': 'Electric',
  'neon-plasma': 'Plasma',
  'neon-ice': 'Ice',
  'neon-rose': 'Rose',
  'neon-teal': 'Teal',
  'neon-gold': 'Gold',
  'neon-indigo': 'Indigo',
  'neon-acid': 'Acid',
  'neon-crimson': 'Crimson',
  'neon-sky': 'Sky',
};

interface Project {
  id: number;
  name: string;
  path: string;
  setupCommands: string | null;
  isGitRepo: boolean;
  defaultBranch: string | null;
  defaultWorktree: boolean;
  color: string | null;
  defaultModel: string;
  defaultThinkingLevel: 'off' | 'low' | 'medium' | 'high';
  providerID: string;
}

interface ProjectFormProps {
  project?: Project;
  onDone: () => void;
}

export default observer(function ProjectForm({ project, onDone }: ProjectFormProps) {
  const [name, setName] = useState(project?.name ?? '');
  const [path, setPath] = useState(project?.path ?? '');
  const [setupCommands, setSetupCommands] = useState(project?.setupCommands ?? '');
  const isGitRepo = project?.isGitRepo ?? false;
  const [defaultBranch, setDefaultBranch] = useState(project?.defaultBranch ?? '');
  const [defaultWorktree, setDefaultWorktree] = useState(project?.defaultWorktree ?? false);
  const [color, setColor] = useState(project?.color ?? '');
  const [defaultModel, setDefaultModel] = useState(project?.defaultModel ?? 'sonnet');
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState<'off' | 'low' | 'medium' | 'high'>(
    project?.defaultThinkingLevel ?? 'high',
  );
  const [providerID, setProviderID] = useState(project?.providerID ?? 'anthropic');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projects = useProjectStore();
  const config = useConfigStore();

  const isValid = name.trim() && path.trim() && (!isGitRepo || defaultBranch);

  function handleProviderChange(newProvider: string) {
    setProviderID(newProvider);
    setDefaultModel(config.getDefaultModel(newProvider));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;

    setError(null);
    setPending(true);

    const data = {
      name: name.trim(),
      path: path.trim(),
      setupCommands: setupCommands || undefined,
      defaultBranch: (isGitRepo && defaultBranch ? defaultBranch : undefined) as 'main' | 'dev' | undefined,
      defaultWorktree: isGitRepo ? defaultWorktree : undefined,
      color: color || undefined,
      defaultModel,
      defaultThinkingLevel,
      providerID,
    };

    try {
      if (project) {
        await projects.updateProject({ id: project.id, ...data });
      } else {
        await projects.createProject(data);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{project ? 'Edit Project' : 'Add Project'}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="space-y-3">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Name</label>
                <Input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Project" />
              </div>

              {/* Path */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Path</label>
                <Input
                  type="text"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/home/ryan/Code/my-project"
                  className="font-mono"
                />
              </div>

              {/* Provider */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Provider</label>
                <Select value={providerID} onValueChange={handleProviderChange}>
                  <SelectTrigger className="w-full">
                    <span data-slot="select-value">
                      {config.getProvider(providerID)?.label ?? providerID}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {config.allProviders.map(([id, p]) => (
                      <SelectItem key={id} value={id}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Color */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Color</label>
                <div className="flex gap-2 flex-wrap">
                  {NEON_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      className={`w-7 h-7 rounded-full border-2 transition-all ${
                        color === c ? 'border-foreground scale-110' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: `var(--${c})` }}
                      title={COLOR_LABELS[c]}
                    />
                  ))}
                </div>
              </div>

              {/* Setup Commands */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Setup Commands</label>
                <Textarea
                  value={setupCommands}
                  onChange={(e) => setSetupCommands(e.target.value)}
                  placeholder={'Commands to run in worktree after creation, e.g.\nyarn install\ncp .env.example .env'}
                  rows={3}
                  className="font-mono"
                />
              </div>

              {/* Default Branch — only for git repos */}
              {isGitRepo && (
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">Default Branch</label>
                  <Select value={defaultBranch} onValueChange={setDefaultBranch}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select branch..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="main">main</SelectItem>
                      <SelectItem value="dev">dev</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {isGitRepo && (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="defaultWorktree"
                    checked={defaultWorktree}
                    onCheckedChange={(checked) => setDefaultWorktree(checked === true)}
                  />
                  <label htmlFor="defaultWorktree" className="text-sm font-medium text-muted-foreground">
                    Default to worktree for new cards
                  </label>
                </div>
              )}

              {/* Default Model */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Default Model</label>
                <Select key={providerID} value={defaultModel} onValueChange={setDefaultModel}>
                  <SelectTrigger className="w-full">
                    <span data-slot="select-value">
                      {config.getModel(providerID, defaultModel)?.label ?? defaultModel}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {config.getModels(providerID).map(([alias, m]) => (
                      <SelectItem key={alias} value={alias}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Default Thinking */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Default Thinking</label>
                <Select
                  value={defaultThinkingLevel}
                  onValueChange={(v) => setDefaultThinkingLevel(v as 'off' | 'low' | 'medium' | 'high')}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Error display */}
            {error && (
              <Alert variant="destructive" className="mt-3">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* Actions */}
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onDone}>
                Cancel
              </Button>
              <Button type="submit" disabled={!isValid || pending}>
                {pending ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
});
