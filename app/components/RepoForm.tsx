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
import { AlertCircle } from 'lucide-react';

interface Repo {
  id: number;
  name: string;
  path: string;
  setupCommands: string | null;
  isGitRepo: boolean;
  defaultBranch: string | null;
}

interface RepoFormProps {
  repo?: Repo;
  onDone: () => void;
}

export default function RepoForm({ repo, onDone }: RepoFormProps) {
  const [name, setName] = useState(repo?.name ?? '');
  const [path, setPath] = useState(repo?.path ?? '');
  const [setupCommands, setSetupCommands] = useState(repo?.setupCommands ?? '');
  const [isGitRepo, setIsGitRepo] = useState(repo?.isGitRepo ?? false);
  const [defaultBranch, setDefaultBranch] = useState(repo?.defaultBranch ?? '');
  const [showBrowser, setShowBrowser] = useState(false);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: freshRepo } = useQuery(
    trpc.repos.get.queryOptions(
      { id: repo!.id },
      { enabled: !!repo }
    )
  );

  useEffect(() => {
    if (freshRepo) setIsGitRepo(freshRepo.isGitRepo);
  }, [freshRepo]);

  const createMutation = useMutation(trpc.repos.create.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.repos.list.queryKey() });
      onDone();
    },
  }));

  const updateMutation = useMutation(trpc.repos.update.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.repos.list.queryKey() });
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
      defaultBranch: isGitRepo && defaultBranch ? defaultBranch : undefined,
    };

    if (repo) {
      updateMutation.mutate({ id: repo.id, ...data });
    } else {
      createMutation.mutate(data);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            {repo ? 'Edit Repository' : 'Add Repository'}
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
                  placeholder="My Repository"
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
