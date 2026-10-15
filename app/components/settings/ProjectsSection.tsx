import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Pencil, Trash2, Plus } from 'lucide-react';
import { useProjectStore, useStore } from '~/stores/context';
import ProjectForm from '~/components/ProjectForm';
import { Button } from '~/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '~/components/ui/table';
import { Card, CardContent } from '~/components/ui/card';

interface Project {
  id: number;
  name: string;
  path: string;
  setupCommands: string | null;
  isGitRepo: boolean;
  defaultBranch: string | null;
  defaultWorktree: boolean;
  defaultModel: string;
  defaultThinkingLevel: 'off' | 'low' | 'medium' | 'high';
  defaultSummarizeThreshold: number;
  color: string;
  providerID: string;
  nodeName: string;
  archived: boolean;
  createdAt: string;
}

export default observer(function ProjectsSection() {
  const projectStore = useProjectStore();
  const store = useStore();
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [deletePending, setDeletePending] = useState<number | null>(null);

  const projectsList = projectStore.all;
  // The store has no hydration flag: an identity only arrives with the first
  // sync, so before that an empty list means "not loaded yet" rather than
  // "no projects".
  const isLoading = projectsList.length === 0 && !store.currentUser;

  async function handleDelete(id: number) {
    setDeletePending(id);
    try {
      await projectStore.deleteProject(id);
    } finally {
      setDeletePending(null);
    }
  }

  function closeForm() {
    setEditingProject(null);
    setShowAddForm(false);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Projects</h2>
          <p className="text-xs text-muted-foreground max-w-prose mt-1">
            Where cards run. Each project binds to a node and inherits that node&apos;s providers.
          </p>
        </div>
        {!showAddForm && !editingProject && (
          <Button size="sm" onClick={() => setShowAddForm(true)}>
            <Plus />
            Add Project
          </Button>
        )}
      </div>

      {showAddForm && <ProjectForm onDone={closeForm} />}
      {editingProject && <ProjectForm project={editingProject} onDone={closeForm} />}

      {!showAddForm && !editingProject && (
        <>
          {isLoading && <p className="text-sm text-muted-foreground">Loading projects...</p>}

          {projectsList.length === 0 && !isLoading && (
            <div className="text-center py-12 text-muted-foreground">
              <p className="text-sm">No projects configured yet.</p>
              <Button variant="link" onClick={() => setShowAddForm(true)} className="mt-2">
                Add your first project
              </Button>
            </div>
          )}

          {projectsList.length > 0 && (
            <Card>
              <CardContent className="py-4">
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
                                style={{ backgroundColor: project.color }}
                              />
                            )}
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-sm">{project.name}</span>
                                {project.archived && (
                                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                    Archived
                                  </span>
                                )}
                              </div>
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
                              disabled={deletePending === project.id}
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
        </>
      )}
    </div>
  );
});
