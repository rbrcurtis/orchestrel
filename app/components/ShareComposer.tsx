import { useEffect, useMemo, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { NewCardDetail } from '~/components/CardDetail';
import { NewChatComposer } from '~/routes/chat.$projectId';
import { useProjectStore, useStore } from '~/stores/context';
import {
  assembleSharedFile,
  connectShareExtension,
  finishShare,
  type ShareBridgeTransport,
  type SharedNativeManifest,
} from '~/lib/share-extension-bridge';

type Mode = 'card' | 'chat';

export function ShareComposer({ mode, projectId }: { mode: Mode; projectId?: number }) {
  const store = useStore();
  const projectStore = useProjectStore();
  const [manifest, setManifest] = useState<SharedNativeManifest | null>(null);
  const [transport, setTransport] = useState<ShareBridgeTransport | null>(null);
  const [files, setFiles] = useState<File[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [complete, setComplete] = useState(false);
  const native = useMemo(() => typeof window !== 'undefined' && Boolean(window.webkit?.messageHandlers?.orchestrelShare), []);

  useEffect(() => {
    store.subscribe(['ready', 'running', 'review', 'done']);
  }, [store]);

  useEffect(() => {
    const bridge = connectShareExtension((next) => {
      setManifest(next);
      setErrors(next.errors);
    });
    setTransport(bridge);
  }, []);

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

  function finish() {
    setComplete(true);
    window.setTimeout(() => finishShare('complete'), 450);
  }

  if (!native) return <CenteredMessage title="iOS Share" body="Open this page from the iOS share sheet." />;
  if (!manifest || !files) return <CenteredMessage title="Preparing share" body="Reading the items you shared…" loading />;
  if (complete) return <CenteredMessage title={mode === 'chat' ? 'Chat started' : 'Card created'} body="Returning to the app you shared from." success />;

  if (mode === 'chat') {
    const project = projectId != null ? projectStore.getProject(projectId) : undefined;
    if (!project) return <CenteredMessage title="Preparing chat" body="Loading the project…" loading />;
    return (
      <main className="min-h-dvh bg-background">
        <NewChatComposer
          project={project}
          initialDescription={manifest.text}
          initialFiles={files}
          initialFileErrors={errors}
          attachmentDraftId={manifest.id}
          onCreated={finish}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto h-dvh max-w-3xl bg-background">
      <NewCardDetail
        column="running"
        initialDescription={manifest.text}
        initialFiles={files}
        initialFileErrors={errors}
        attachmentDraftId={manifest.id}
        onCreated={() => finish()}
        onSaved={finish}
        onClose={() => finishShare('cancel')}
      />
    </main>
  );
}

function CenteredMessage({ title, body, loading, success }: { title: string; body: string; loading?: boolean; success?: boolean }) {
  return <main className="grid min-h-dvh place-items-center bg-background px-6 text-center"><div>{loading ? <LoaderCircle className="mx-auto mb-4 size-7 animate-spin text-primary" /> : success ? <Check className="mx-auto mb-4 size-8 text-primary" /> : null}<h1 className="text-xl font-semibold">{title}</h1><p className="mt-2 text-sm text-muted-foreground">{body}</p></div></main>;
}
