import { useState, useRef, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { useNavigate } from 'react-router';
import { Send } from 'lucide-react';
import { useCardStore, useProjectStore } from '~/stores/context';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '~/components/ui/select';
import { Textarea } from '~/components/ui/textarea';
import { Button } from '~/components/ui/button';

const ChatIndex = observer(function ChatIndex() {
  const navigate = useNavigate();
  const cardStore = useCardStore();
  const projectStore = useProjectStore();

  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState<number | null>(() => {
    const active = projectStore.active;
    return active.length > 0 ? active[0].id : null;
  });
  const [creating, setCreating] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-redirect to most recent active card
  useEffect(() => {
    if (!cardStore.hydrated) return;
    const recent = cardStore.cardsByCreatedDesc;
    const active = recent.find((c) => c.column === 'running' || c.column === 'review');
    if (active) {
      navigate(`/chat/${active.id}`, { replace: true });
    }
  }, [cardStore.hydrated]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (projectId == null && projectStore.active.length > 0) {
      setProjectId(projectStore.active[0].id);
    }
  }, [projectStore.active.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit() {
    if (!description.trim() || !projectId) return;
    setCreating(true);
    try {
      const card = await cardStore.createChatCard({ description: description.trim(), projectId });
      navigate(`/chat/${card.id}`);
    } finally {
      setCreating(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div className="h-full flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-2xl space-y-4">
        <h2 className="text-2xl font-bold text-center text-foreground mb-6">What are you working on?</h2>
        <div className="space-y-3">
          <Textarea
            ref={textareaRef}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your task..."
            rows={4}
            className="resize-none text-base"
          />
          <div className="flex items-center gap-3">
            <Select value={projectId != null ? String(projectId) : ''} onValueChange={(v) => setProjectId(Number(v))}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                {projectStore.active.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    <span className="flex items-center gap-2">
                      {p.color && <span className="size-2 rounded-full" style={{ backgroundColor: p.color }} />}
                      {p.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="flex-1" />
            <Button onClick={handleSubmit} disabled={!description.trim() || !projectId || creating} className="gap-2">
              <Send className="size-4" />
              {creating ? 'Starting...' : 'Start Chat'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});

export default ChatIndex;
