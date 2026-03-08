import { useState } from 'react';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ProjectForm from '~/components/ProjectForm';
import { Button } from '~/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '~/components/ui/table';
import { Card, CardContent } from '~/components/ui/card';
import { X, Pencil, Trash2, Plus } from 'lucide-react';

interface Project {
  id: number;
  name: string;
  path: string;
  setupCommands: string | null;
  isGitRepo: boolean;
  defaultBranch: string | null;
  color: string | null;
  createdAt: string;
}

export default function SettingsProjectsModal({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: projectsList, isLoading } = useQuery(trpc.projects.list.queryOptions());
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const deleteMutation = useMutation(trpc.projects.delete.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
    },
  }));

  function handleDelete(id: number) {
    deleteMutation.mutate({ id });
  }

  function closeForm() {
    setEditingProject(null);
    setShowAddForm(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background">
      <div className="max-w-3xl mx-auto w-full px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-foreground">Project Settings</h1>
          <div className="flex items-center gap-2">
          {!showAddForm && !editingProject && (
            <Button size="sm" onClick={() => setShowAddForm(true)}>
              <Plus />
              Add Project
            </Button>
          )}
          <button
            onClick={onClose}
            className="rounded-md p-1.5 transition-colors hover:bg-white/10 text-muted-foreground"
          >
            <X className="size-6" />
          </button>
          </div>
        </div>

        {/* Add form */}
        {showAddForm && (
          <div className="mb-6">
            <ProjectForm onDone={closeForm} />
          </div>
        )}

        {/* Edit form */}
        {editingProject && (
          <div className="mb-6">
            <ProjectForm project={editingProject} onDone={closeForm} />
          </div>
        )}

        {/* Project list */}
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading projects...</p>
        )}

        {projectsList && projectsList.length === 0 && !showAddForm && (
          <div className="text-center py-12 text-muted-foreground">
            <p className="text-sm">No projects configured yet.</p>
            <Button
              variant="link"
              onClick={() => setShowAddForm(true)}
              className="mt-2"
            >
              Add your first project
            </Button>
          </div>
        )}

        {projectsList && projectsList.length > 0 && (
          <Card>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projectsList.map((project) => (
                    <TableRow key={project.id}>
                      <TableCell>
                        <div className="flex items-center gap-2 min-w-0">
                          {project.color && (
                            <span
                              className="w-3 h-3 rounded-full shrink-0"
                              style={{ backgroundColor: `var(--${project.color})` }}
                            />
                          )}
                          <div className="min-w-0">
                            <span className="font-medium text-sm">{project.name}</span>
                            <p className="text-xs text-muted-foreground truncate mt-0.5">{project.path}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => {
                              setShowAddForm(false);
                              setEditingProject(project as Project);
                            }}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => handleDelete(project.id)}
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
