import { useEffect, useMemo, useState } from 'react';
import { Check, LoaderCircle, Send } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { FileAttachments, FilePickerButton } from '~/components/FileAttachments';
import { uploadFiles } from '~/lib/file-attachments';
import {
  assembleSharedFile,
  connectShareExtension,
  finishShare,
  type ShareBridgeTransport,
  type SharedNativeManifest,
} from '~/lib/share-extension-bridge';

type Project = { id: number; name: string; archived: boolean };
type Mode = 'card' | 'chat';
type Column = 'backlog' | 'ready' | 'running' | 'review' | 'done';

const statusLabels: Record<Column, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  running: 'Running',
  review: 'Review',
  done: 'Done',
};

export function ShareComposer({ mode, projectId }: { mode: Mode; projectId?: number }) {
  const [manifest, setManifest] = useState<SharedNativeManifest | null>(null);
  const [transport, setTransport] = useState<ShareBridgeTransport | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState(projectId?.toString() ?? '');
  const [title, setTitle] = useState('');
  const [column, setColumn] = useState<Column>('backlog');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [complete, setComplete] = useState(false);
  const native = useMemo(() => typeof window !== 'undefined' && Boolean(window.webkit?.messageHandlers?.orchestrelShare), []);

  useEffect(() => {
    const bridge = connectShareExtension((next) => {
      setManifest(next);
      setText(next.text);
      setErrors(next.errors);
    });
    setTransport(bridge);
  }, []);

  useEffect(() => {
    if (mode !== 'card') return;
    void fetch('/api/projects').then(async (res) => {
      if (!res.ok) throw new Error('Could not load projects');
      const body = await res.json() as { projects: Project[] };
      const active = body.projects.filter((project) => !project.archived);
      setProjects(active);
      setSelectedProject((current) => current || active[0]?.id.toString() || '');
    }).catch((error: unknown) => setErrors((current) => [...current, error instanceof Error ? error.message : 'Could not load projects']));
  }, [mode]);

  useEffect(() => {
    if (!manifest || !transport) return;
    let cancelled = false;
    void (async () => {
      const imported: File[] = [];
      const importErrors: string[] = [];
      for (const nativeFile of manifest.files) {
        try {
          imported.push(await assembleSharedFile(transport, nativeFile));
        } catch (error) {
          importErrors.push(`${nativeFile.name}: ${error instanceof Error ? error.message : 'Could not import file'}`);
        }
      }
      if (!cancelled) {
        setFiles(imported);
        setErrors((current) => [...current, ...importErrors]);
      }
    })();
    return () => { cancelled = true; };
  }, [manifest, transport]);

  async function submit() {
    const description = text.trim() || (files.length ? 'Please review the attached files.' : '');
    const targetProject = Number(selectedProject);
    if (!description || !targetProject || submitting || !manifest) return;

    setSubmitting(true);
    setErrors([]);
    try {
      const pendingInitialFiles = files.length ? await uploadFiles(files, { draftId: manifest.id }) : undefined;
      let cardTitle = title.trim();
      if (mode === 'chat') {
        cardTitle = 'New chat';
        try {
          const suggestion = await fetch('/api/cards/suggest-title', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description }),
          });
          if (suggestion.ok) {
            const body = await suggestion.json() as { title?: unknown };
            if (typeof body.title === 'string' && body.title.trim()) cardTitle = body.title.trim();
          }
        } catch {
          // Title generation is best effort; card creation must still proceed.
        }
      }
      if (!cardTitle) throw new Error('Enter a card title');
      const res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: cardTitle,
          description,
          projectId: targetProject,
          column: mode === 'chat' ? 'running' : column,
          archiveOthers: mode === 'chat' ? true : undefined,
          pendingInitialFiles,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof body?.error === 'string' ? body.error : 'Could not create card');
      }
      setComplete(true);
      window.setTimeout(() => finishShare('complete'), 450);
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Could not submit share']);
      setSubmitting(false);
    }
  }

  if (!native) {
    return <CenteredMessage title="iOS Share" body="Open this page from the iOS share sheet." />;
  }
  if (!manifest) {
    return <CenteredMessage title="Preparing share" body="Reading the items you shared…" loading />;
  }
  if (complete) {
    return <CenteredMessage title={mode === 'chat' ? 'Chat started' : 'Card created'} body="Returning to the app you shared from." success />;
  }

  const canSubmit = Boolean((text.trim() || files.length) && selectedProject && (mode === 'chat' || title.trim()));
  return (
    <main className="min-h-dvh bg-[radial-gradient(circle_at_50%_-10%,hsl(var(--primary)/0.16),transparent_28rem)] px-4 py-5">
      <section className="mx-auto max-w-xl overflow-hidden rounded-3xl border border-border/70 bg-card/90 shadow-2xl shadow-black/30 backdrop-blur">
        <header className="border-b border-border/70 px-5 py-4">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">{mode === 'chat' ? 'Orc Chat' : 'Orchestrel'}</p>
          <h1 className="mt-1 text-xl font-semibold">{mode === 'chat' ? 'Start a chat' : 'Create a card'}</h1>
        </header>
        <div className="space-y-4 p-5">
          {mode === 'card' && (
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5 text-sm"><span className="text-muted-foreground">Project</span>
                <Select value={selectedProject} onValueChange={setSelectedProject}><SelectTrigger className="w-full"><SelectValue placeholder="Project" /></SelectTrigger><SelectContent>{projects.map((project) => <SelectItem key={project.id} value={project.id.toString()}>{project.name}</SelectItem>)}</SelectContent></Select>
              </label>
              <label className="space-y-1.5 text-sm"><span className="text-muted-foreground">Status</span>
                <Select value={column} onValueChange={(value) => setColumn(value as Column)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(statusLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
              </label>
            </div>
          )}
          {mode === 'card' && <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Card title" autoFocus />}
          <FileAttachments files={files} errors={errors} disabled={submitting} onFilesChange={setFiles} onErrorsChange={setErrors}>
            {({ onPaste, openPicker, dragging }) => <div className={`relative rounded-xl border border-border/70 bg-background/40 ${dragging ? 'ring-2 ring-primary/50' : ''}`}><Textarea value={text} onChange={(event) => setText(event.target.value)} onPaste={onPaste} placeholder={mode === 'chat' ? 'What should Orc do?' : 'Add commentary…'} rows={8} className="min-h-44 resize-none border-0 bg-transparent p-4 pr-11 shadow-none focus-visible:ring-0" /><div className="absolute bottom-3 right-3"><FilePickerButton onClick={openPicker} disabled={submitting} /></div></div>}
          </FileAttachments>
          <div className="flex items-center gap-3 pt-1">
            <Button variant="ghost" onClick={() => finishShare('cancel')} disabled={submitting}>Cancel</Button>
            <span className="flex-1" />
            <Button onClick={() => void submit()} disabled={!canSubmit || submitting} className="gap-2 rounded-full px-5">{submitting ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}{submitting ? 'Submitting…' : mode === 'chat' ? 'Start chat' : 'Create card'}</Button>
          </div>
        </div>
      </section>
    </main>
  );
}

function CenteredMessage({ title, body, loading, success }: { title: string; body: string; loading?: boolean; success?: boolean }) {
  return <main className="grid min-h-dvh place-items-center bg-background px-6 text-center"><div>{loading ? <LoaderCircle className="mx-auto mb-4 size-7 animate-spin text-primary" /> : success ? <Check className="mx-auto mb-4 size-8 text-primary" /> : null}<h1 className="text-xl font-semibold">{title}</h1><p className="mt-2 text-sm text-muted-foreground">{body}</p></div></main>;
}
