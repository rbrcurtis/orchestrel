import { useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { useParams, useNavigate } from 'react-router';
import { useCardStore, useProjectStore } from '~/stores/context';
import { SessionView } from '~/components/SessionView';
import { InlineEdit } from '~/components/InlineEdit';

const ChatCardView = observer(function ChatCardView() {
  const { cardId: cardIdParam } = useParams();
  const navigate = useNavigate();
  const cardStore = useCardStore();
  const projectStore = useProjectStore();
  const cardId = Number(cardIdParam);
  const card = cardStore.getCard(cardId);
  const project = card?.projectId ? projectStore.getProject(card.projectId) : null;

  useEffect(() => {
    if (cardStore.hydrated && !card) {
      navigate('/chat', { replace: true });
    }
  }, [cardStore.hydrated, card]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!card) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border">
        <InlineEdit
          value={card.title}
          onSave={(v) => cardStore.updateCard({ id: card.id, title: v })}
          className="text-sm font-medium flex-1 min-w-0"
          placeholder="Untitled"
          minLength={1}
        />
        {project && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            {project.color && <span className="size-2 rounded-full" style={{ backgroundColor: project.color }} />}
            {project.name}
          </span>
        )}
      </div>
      <SessionView
        cardId={card.id}
        sessionId={card.sessionId}
        accentColor={project?.color}
        model={card.model ?? 'sonnet'}
        providerID={project?.providerID ?? 'anthropic'}
        thinkingLevel={card.thinkingLevel ?? 'high'}
      />
    </div>
  );
});

export default ChatCardView;
