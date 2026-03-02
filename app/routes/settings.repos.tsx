import { useState } from 'react';
import { Link } from 'react-router';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import RepoForm from '~/components/RepoForm';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '~/components/ui/table';
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card';
import { ArrowLeft, Pencil, Trash2, Plus } from 'lucide-react';

interface Repo {
  id: number;
  name: string;
  displayName: string;
  path: string;
  host: 'github' | 'bitbucket';
  setupCommands: string | null;
  createdAt: string;
}

export default function SettingsRepos() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: repos, isLoading } = useQuery(trpc.repos.list.queryOptions());
  const [editingRepo, setEditingRepo] = useState<Repo | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const deleteMutation = useMutation(trpc.repos.delete.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.repos.list.queryKey() });
    },
  }));

  function handleDelete(id: number) {
    deleteMutation.mutate({ id });
  }

  function closeForm() {
    setEditingRepo(null);
    setShowAddForm(false);
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" asChild>
              <Link to="/">
                <ArrowLeft />
              </Link>
            </Button>
            <h1 className="text-xl font-bold text-gray-900">Repository Settings</h1>
          </div>
          {!showAddForm && !editingRepo && (
            <Button size="sm" onClick={() => setShowAddForm(true)}>
              <Plus />
              Add Repository
            </Button>
          )}
        </div>

        {/* Add form */}
        {showAddForm && (
          <div className="mb-6">
            <RepoForm onDone={closeForm} />
          </div>
        )}

        {/* Edit form */}
        {editingRepo && (
          <div className="mb-6">
            <RepoForm repo={editingRepo} onDone={closeForm} />
          </div>
        )}

        {/* Repo list */}
        {isLoading && (
          <p className="text-sm text-gray-500">Loading repositories...</p>
        )}

        {repos && repos.length === 0 && !showAddForm && (
          <div className="text-center py-12 text-gray-500">
            <p className="text-sm">No repositories configured yet.</p>
            <Button
              variant="link"
              onClick={() => setShowAddForm(true)}
              className="mt-2"
            >
              Add your first repository
            </Button>
          </div>
        )}

        {repos && repos.length > 0 && (
          <Card>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Repository</TableHead>
                    <TableHead>Host</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {repos.map((repo) => (
                    <TableRow key={repo.id}>
                      <TableCell>
                        <div className="min-w-0">
                          <span className="font-medium text-sm">{repo.displayName}</span>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">{repo.path}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={repo.host === 'github' ? 'secondary' : 'outline'}>
                          {repo.host === 'github' ? 'GitHub' : 'Bitbucket'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => {
                              setShowAddForm(false);
                              setEditingRepo(repo as Repo);
                            }}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => handleDelete(repo.id)}
                            disabled={deleteMutation.isPending}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
