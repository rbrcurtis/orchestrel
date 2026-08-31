import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, LoaderCircle, Send } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import { useCardStore, useProjectStore } from '~/stores/context';
import { FileAttachments, FilePickerButton } from '~/components/FileAttachments';
import { uploadFiles } from '~/lib/file-attachments';
import type { Project } from '../../src/shared/ws-protocol';

type NewChatComposerProps = {
  project: Project;
  initialDescription?: string;
  initialFiles?: File[];
  initialFileErrors?: string[];
  attachmentDraftId?: string;
  onCreated?: (cardId: number) => void;
};

export const NewChatComposer = observer(function NewChatComposer({
  project,
  initialDescription = '',
  initialFiles = [],
  initialFileErrors = [],
  attachmentDraftId,
  onCreated,
}: NewChatComposerProps) {
  const navigate = useNavigate();
  const cardStore = useCardStore();
  const [description, setDescription] = useState(initialDescription);
  const [creating, setCreating] = useState(false);
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [fileErrors, setFileErrors] = useState<string[]>(initialFileErrors);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [project.id]);

  function handleSubmit() {
    const text = description.trim() || (files.length ? 'Please review the attached files.' : '');
    if (!text || creating) return;

    setCreating(true);
    void (async () => {
      try {
        const pendingInitialFiles = files.length > 0
          ? await uploadFiles(files, { draftId: attachmentDraftId ?? crypto.randomUUID() })
          : undefined;
        const card = await cardStore.createChatCard({ description: text, projectId: project.id, pendingInitialFiles });
        if (onCreated) onCreated(card.id);
        else navigate(`/chat/${project.id}/${card.id}`);
      } finally {
        setCreating(false);
      }
    })();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Enter and Shift+Enter add a line; Cmd/Ctrl+Enter submits.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center px-5 py-8">
      <div className="w-full max-w-3xl space-y-6">
        {!onCreated && (
          <Link to="/chat" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="size-4" />
            All projects
          </Link>
        )}
        <div className="rounded-3xl border border-border/70 bg-card/80 p-3 shadow-2xl shadow-black/20 backdrop-blur">
          <FileAttachments files={files} errors={fileErrors} onFilesChange={setFiles} onErrorsChange={setFileErrors}>
            {({ onPaste, openPicker, dragging }) => (
              <div className={`relative ${dragging ? 'rounded-md ring-2 ring-neon-cyan/50' : ''}`}>
                <Textarea ref={textareaRef} value={description} onChange={(e) => setDescription(e.target.value)} onKeyDown={handleKeyDown} onPaste={onPaste} placeholder="How can I help you today?" rows={8} className="min-h-48 resize-none border-0 bg-transparent p-4 pr-10 text-base shadow-none focus-visible:ring-0" />
                <div className="absolute bottom-2 right-2"><FilePickerButton onClick={openPicker} /></div>
              </div>
            )}
          </FileAttachments>
          <div className="flex items-center gap-3 border-t border-border/70 px-2 pt-3">
            <p className="text-xs text-muted-foreground">Enter adds a line • Cmd/Ctrl+Enter sends</p>
            <span className="flex-1" />
            <Button onClick={handleSubmit} disabled={(!description.trim() && files.length === 0) || creating} className="gap-2 rounded-full px-5">
              {creating ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
              {creating ? 'Starting…' : 'Start chat'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});

const ChatProjectView = observer(function ChatProjectView() {
  const { projectId: projectIdParam } = useParams();
  const navigate = useNavigate();
  const projectStore = useProjectStore();
  const project = projectStore.resolveProjectRef(projectIdParam);

  useEffect(() => {
    if (!project && projectStore.all.length > 0) {
      navigate('/chat', { replace: true });
    }
  }, [navigate, project, projectStore.all.length]);

  if (!project) return null;

  return (
    <div className="h-full min-h-0 overflow-hidden bg-[radial-gradient(circle_at_50%_0%,hsl(var(--primary)/0.12),transparent_34rem)]">
      <NewChatComposer project={project} />
    </div>
  );
});

export default ChatProjectView;
