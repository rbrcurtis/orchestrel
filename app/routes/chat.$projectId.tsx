import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, LoaderCircle, Send } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import { useCardStore, useProjectStore } from '~/stores/context';
import { FileAttachments, FilePickerButton } from '~/components/FileAttachments';
import { uploadFiles } from '~/lib/file-attachments';
import { discardDraft, importSharedDrafts, saveDraft, type SharedDraft } from '~/lib/shared-drafts';
import { SharedDraftNotice } from '~/components/SharedDraftNotice';

const ChatProjectView = observer(function ChatProjectView() {
  const { projectId: projectIdParam } = useParams();
  const navigate = useNavigate();
  const cardStore = useCardStore();
  const projectStore = useProjectStore();
  const project = projectStore.resolveProjectRef(projectIdParam);
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [sharedDraft, setSharedDraft] = useState<SharedDraft | null>(null);
  const [queuedDrafts, setQueuedDrafts] = useState<SharedDraft[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!project && projectStore.all.length > 0) {
      navigate('/chat', { replace: true });
    }
  }, [navigate, project, projectStore.all.length]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [project?.id]);

  useEffect(() => {
    if (project?.id !== 1) return;
    void importSharedDrafts('chat').then((incoming) => {
      if (!incoming.length) return;
      if (description.trim() || files.length) {
        setQueuedDrafts(incoming);
        return;
      }
      const [first, ...rest] = incoming;
      setSharedDraft(first);
      setDescription(first.text);
      setFiles(first.files);
      setFileErrors(first.errors);
      setQueuedDrafts(rest);
    });
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sharedDraft) return;
    void saveDraft({ ...sharedDraft, text: description, files, errors: fileErrors });
  }, [sharedDraft, description, files, fileErrors]);

  function handleSubmit() {
    const text = description.trim() || (files.length ? 'Please review the attached files.' : '');
    if (!text || creating || !project) return;

    setCreating(true);
    void (async () => {
      try {
        const pendingInitialFiles = files.length > 0
          ? await uploadFiles(files, { draftId: sharedDraft?.id ?? crypto.randomUUID() })
          : undefined;
        const card = await cardStore.createChatCard({ description: text, projectId: project.id, pendingInitialFiles });
        if (sharedDraft) await discardDraft(sharedDraft);
        navigate(`/chat/${project.id}/${card.id}`);
      } finally {
        setCreating(false);
      }
    })();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    handleSubmit();
  }

  if (!project) return null;

  return (
    <div className="h-full min-h-0 overflow-hidden bg-[radial-gradient(circle_at_50%_0%,hsl(var(--primary)/0.12),transparent_34rem)]">
      <div className="flex h-full flex-col items-center justify-center px-5 py-8">
        <div className="w-full max-w-3xl space-y-6">
          <Link
            to="/chat"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            All projects
          </Link>
          <div className="rounded-3xl border border-border/70 bg-card/80 p-3 shadow-2xl shadow-black/20 backdrop-blur">
            <SharedDraftNotice
              count={queuedDrafts.length}
              onOpen={() => {
                const [next, ...rest] = queuedDrafts;
                if (!next) return;
                setSharedDraft(next);
                setDescription(next.text);
                setFiles(next.files);
                setFileErrors(next.errors);
                setQueuedDrafts(rest);
              }}
              onDiscard={() => {
                for (const item of queuedDrafts) void discardDraft(item);
                setQueuedDrafts([]);
              }}
            />
            <FileAttachments files={files} errors={fileErrors} onFilesChange={setFiles} onErrorsChange={setFileErrors}>
              {({ onPaste, openPicker, dragging }) => (
                <div className={`relative ${dragging ? 'rounded-md ring-2 ring-neon-cyan/50' : ''}`}>
                  <Textarea
                    ref={textareaRef}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={onPaste}
                    placeholder="How can I help you today?"
                    rows={8}
                    className="min-h-48 resize-none border-0 bg-transparent p-4 pr-10 text-base shadow-none focus-visible:ring-0"
                  />
                  <div className="absolute bottom-2 right-2"><FilePickerButton onClick={openPicker} /></div>
                </div>
              )}
            </FileAttachments>
            <div className="flex items-center gap-3 border-t border-border/70 px-2 pt-3">
              <p className="text-xs text-muted-foreground">Enter sends • Shift+Enter adds a line</p>
              <span className="flex-1" />
              <Button onClick={handleSubmit} disabled={(!description.trim() && files.length === 0) || creating} className="gap-2 rounded-full px-5">
                {creating ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
                {creating ? 'Starting…' : 'Start chat'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default ChatProjectView;
