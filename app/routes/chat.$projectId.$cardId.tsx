import { useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { InlineEdit } from '~/components/InlineEdit';
import { SessionView } from '~/components/SessionView';
import { useCardStore, useProjectStore } from '~/stores/context';

const ChatCardView = observer(function ChatCardView() {
  const { projectId: projectIdParam, cardId: cardIdParam } = useParams();
  const navigate = useNavigate();
  const cardStore = useCardStore();
  const projectStore = useProjectStore();

  const project = projectStore.resolveProjectRef(projectIdParam);
  const numericCardRef = Number(cardIdParam);
  const card = cardStore.getCard(numericCardRef);

  useEffect(() => {
    if (!cardStore.hydrated) return;
    const invalidCardRef = !Number.isFinite(numericCardRef) || numericCardRef <= 0 || !Number.isInteger(numericCardRef);

    if (!project || invalidCardRef || !card || card.projectId !== project.id) {
      navigate(project ? `/chat/${project.id}` : '/chat', { replace: true });
    }
  }, [card, cardStore.hydrated, navigate, numericCardRef, project]);

  if (!project || !card || card.projectId !== project.id) return null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border">
        <Link
          to={`/chat/${project.id}`}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={`Back to ${project.name} new chat`}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <InlineEdit
          value={card.title}
          onSave={async (v) => { await cardStore.updateCard({ id: card.id, title: v }); }}
          className="text-sm font-medium flex-1 min-w-0"
          placeholder="Untitled"
          minLength={1}
        />
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
          {project.color && <span className="size-2 rounded-full" style={{ backgroundColor: project.color }} />}
          {project.name}
        </span>
      </div>
      <SessionView
        cardId={card.id}
        sessionId={card.sessionId}
        accentColor={project.color}
        model={card.model ?? 'sonnet'}
        providerID={project.providerID ?? 'anthropic'}
        summarizeThreshold={card.summarizeThreshold ?? 0}
      />
    </div>
  );
});

export default ChatCardView;
