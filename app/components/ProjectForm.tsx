import { useState, useEffect } from 'react';
import { useTRPC } from '~/lib/trpc';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import DirectoryBrowser from './DirectoryBrowser';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '~/components/ui/select';
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Checkbox } from '~/components/ui/checkbox';
import { AlertCircle } from 'lucide-react';

const NEON_COLORS = [
  'neon-cyan', 'neon-magenta', 'neon-violet', 'neon-amber',
  'neon-lime', 'neon-coral', 'neon-electric', 'neon-plasma',
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
  defaultModel: 'sonnet' | 'opus';
  defaultThinkingLevel: 'off' | 'low' | 'medium' | 'high';
}

interface ProjectFormProps {
  project?: Project;
  onDone: () => void;
}

export default function ProjectForm({ project, onDone }: ProjectFormProps) {
  const [name, setName] = useState(project?.name ?? '');
  const [path, setPath] = useState(project?.path ?? '');
  const [setupCommands, setSetupCommands] = useState(project?.setupCommands ?? '');
  const [isGitRepo, setIsGitRepo] = useState(project?.isGitRepo ?? false);
  const [defaultBranch, setDefaultBranch] = useState(project?.defaultBranch ?? '');
  const [defaultWorktree, setDefaultWorktree] = useState(project?.defaultWorktree ?? false);
  const [color, setColor] = useState(project?.color ?? '');
  const [defaultModel, setDefaultModel] = useState<'sonnet' | 'opus'>(project?.defaultModel ?? 'sonnet');
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState<'off' | 'low' | 'medium' | 'high'>(project?.defaultThinkingLevel ?? 'high');
  const [showBrowser, setShowBrowser] = useState(false);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: freshProject } = useQuery(
    trpc.projects.get.queryOptions(
      { id: project?.id ?? 0 },
      { enabled: !!project }
    )
  );

  useEffect(() => {
    if (freshProject) setIsGitRepo(freshProject.isGitRepo);
  }, [freshProject]);

  const createMutation = useMutation(trpc.projects.create.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
      onDone();
    },
  }));

  const updateMutation = useMutation(trpc.projects.update.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
      onDone();
    },
  }));

  const isValid = name.trim() && path.trim() && (!isGitRepo || defaultBranch);
  const isPending = createMutation.isPending || updateMutation.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;

    const data = {
      name: name.trim(),
      path: path.trim(),
      setupCommands: setupCommands || undefined,
      defaultBranch: (isGitRepo && defaultBranch ? defaultBranch : undefined) as 'main' | 'dev' | undefined,
      defaultWorktree: isGitRepo ? defaultWorktree : undefined,
      color: color || undefined,
      defaultModel,
      defaultThinkingLevel,
    };

    if (project) {
      updateMutation.mutate({ id: project.id, ...data });
    } else {
      createMutation.mutate(data);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            {project ? 'Edit Project' : 'Add Project'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="space-y-3">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Name</label>
                <Input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="My Project"
                />
              </div>

              {/* Path */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Path</label>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={path}
                    readOnly
                    placeholder="No directory selected"
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowBrowser(true)}
                  >
                    Browse
                  </Button>
                </div>
              </div>

              {/* Color */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Color</label>
                <div className="flex gap-2 flex-wrap">
                  {NEON_COLORS.map(c => (
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
                  onChange={e => setSetupCommands(e.target.value)}
                  placeholder={"Commands to run in worktree after creation, e.g.\nyarn install\ncp .env.example .env"}
                  rows={3}
                  className="font-mono"
                />
              </div>

              {/* Default Branch — only for git repos */}
              {isGitRepo && (
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">Default Branch</label>
                  <Select
                    value={defaultBranch}
                    onValueChange={setDefaultBranch}
                  >
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
                <Select value={defaultModel} onValueChange={(v) => setDefaultModel(v as 'sonnet' | 'opus')}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sonnet">Sonnet 4.6</SelectItem>
                    <SelectItem value="opus">Opus 4.6</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Default Thinking */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Default Thinking</label>
                <Select value={defaultThinkingLevel} onValueChange={(v) => setDefaultThinkingLevel(v as 'off' | 'low' | 'medium' | 'high')}>
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
            {(createMutation.error || updateMutation.error) && (
              <Alert variant="destructive" className="mt-3">
                <AlertCircle className="size-4" />
                <AlertDescription>
                  {createMutation.error?.message || updateMutation.error?.message}
                </AlertDescription>
              </Alert>
            )}

            {/* Actions */}
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onDone}>
                Cancel
              </Button>
              <Button type="submit" disabled={!isValid || isPending}>
                {isPending ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {showBrowser && (
        <DirectoryBrowser
          initialPath={path || '/home/ryan'}
          onSelect={(selected, gitRepo) => {
            setPath(selected);
            setIsGitRepo(gitRepo);
            setShowBrowser(false);
          }}
          onCancel={() => setShowBrowser(false)}
        />
      )}
    </>
  );
}
