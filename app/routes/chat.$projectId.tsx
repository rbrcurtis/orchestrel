import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, LoaderCircle, Send } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import { useCardStore, useProjectStore } from '~/stores/context';

const ChatProjectView = observer(function ChatProjectView() {
  const { projectId: projectIdParam } = useParams();
  const navigate = useNavigate();
  const cardStore = useCardStore();
  const projectStore = useProjectStore();
  const project = projectStore.resolveProjectRef(projectIdParam);
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!project && projectStore.all.length > 0) {
      navigate('/chat', { replace: true });
    }
  }, [navigate, project, projectStore.all.length]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [project?.id]);

  function handleSubmit() {
    const text = description.trim();
    if (!text || creating || !project) return;

    setCreating(true);
    void (async () => {
      try {
        const card = await cardStore.createChatCard({ description: text, projectId: project.id });
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
            <Textarea
              ref={textareaRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="How can I help you today?"
              rows={8}
              className="min-h-48 resize-none border-0 bg-transparent p-4 text-base shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center gap-3 border-t border-border/70 px-2 pt-3">
              <p className="text-xs text-muted-foreground">Enter sends • Shift+Enter adds a line</p>
              <span className="flex-1" />
              <Button onClick={handleSubmit} disabled={!description.trim() || creating} className="gap-2 rounded-full px-5">
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
