import { useState, useEffect } from 'react';
import { useProjectStore } from '~/stores/context';
import { observer } from 'mobx-react-lite';
import ProjectForm from '~/components/ProjectForm';
import { Button } from '~/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '~/components/ui/table';
import { Card, CardContent } from '~/components/ui/card';
import { X, Pencil, Trash2, Plus } from 'lucide-react';
import { del, get, createStore } from 'idb-keyval';

interface Project {
  id: number;
  name: string;
  path: string;
  setupCommands: string | null;
  isGitRepo: boolean;
  defaultBranch: string | null;
  defaultWorktree: boolean;
  defaultModel: 'sonnet' | 'opus' | 'auto';
  defaultThinkingLevel: 'off' | 'low' | 'medium' | 'high';
  color: string | null;
  providerID: string;
  createdAt: string;
}

const SettingsProjectsModal = observer(function SettingsProjectsModal({ onClose }: { onClose: () => void }) {
  const projectStore = useProjectStore();
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [deletePending, setDeletePending] = useState<number | null>(null);

  const projectsList = projectStore.all;
  const isLoading = projectsList.length === 0;

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

        {!showAddForm && !editingProject && (<>
          {/* Project list */}
          {isLoading && (
            <p className="text-sm text-muted-foreground">Loading projects...</p>
          )}

          {projectsList.length === 0 && !isLoading && (
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

          {projectsList.length > 0 && (
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

          {/* Cache management */}
          <div className="mt-6">
            <h2 className="text-sm font-medium text-muted-foreground mb-3">Storage</h2>
            <CacheSection />
          </div>
        </>)}
      </div>
    </div>
  );
});

export default SettingsProjectsModal;

const CACHE_STORE = createStore('orchestrel-cache', 'store-cache');
const CACHE_KEYS = ['orchestrel:cards', 'orchestrel:projects'];

function CacheSection() {
  const [size, setSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    async function measure() {
      let total = 0;
      for (const key of CACHE_KEYS) {
        const data = await get(key);
        if (data) {
          total += new Blob([JSON.stringify(data)]).size;
        }
      }
      setSize(total);
    }
    measure();
  }, []);

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function handleClear() {
    setClearing(true);
    for (const key of CACHE_KEYS) {
      await del(key, CACHE_STORE);
    }
    setSize(0);
    setClearing(false);
  }

  return (
    <Card>
      <CardContent className="flex items-center justify-between py-4">
        <div>
          <p className="text-sm font-medium">Local Cache</p>
          <p className="text-xs text-muted-foreground">
            {size === null ? 'Calculating...' : formatBytes(size)}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleClear}
          disabled={clearing || size === 0}
        >
          {clearing ? 'Clearing...' : 'Clear'}
        </Button>
      </CardContent>
    </Card>
  );
}
