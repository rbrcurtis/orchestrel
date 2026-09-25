import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { InlineEdit } from '~/components/InlineEdit';
import { SessionView } from '~/components/SessionView';
import { useCardStore, useProjectStore, useSessionStore } from '~/stores/context';
import { dispatchTypeFocus, isTypeFocusKey, isTypingContext } from '~/lib/type-focus';
import type { ConversationEntry } from '~/lib/message-accumulator';

// Title generation runs on llama3.2 with a 512-token context and a fixed
// instruction prefix (~60 tokens). Keep the conversation excerpt near 1500
// chars (~375 tokens) so the instruction is never truncated away.
const TITLE_MESSAGE_LIMIT = 5;
const TITLE_MESSAGE_CHARS = 300;

function recentUserText(conversation: ConversationEntry[]): string {
  return conversation
    .filter((entry): entry is Extract<ConversationEntry, { kind: 'user' }> => entry.kind === 'user')
    .map((entry) => entry.content.trim())
    .filter((text) => text.length > 0)
    .slice(-TITLE_MESSAGE_LIMIT)
    .map((text) => (text.length > TITLE_MESSAGE_CHARS ? text.slice(0, TITLE_MESSAGE_CHARS) : text))
    .join('\n\n');
}

const ChatCardView = observer(function ChatCardView() {
  const { projectId: projectIdParam, cardId: cardIdParam } = useParams();
  const navigate = useNavigate();
  const cardStore = useCardStore();
  const projectStore = useProjectStore();
  const sessionStore = useSessionStore();

  const project = projectStore.resolveProjectRef(projectIdParam);
  const numericCardRef = Number(cardIdParam);
  const card = cardStore.getCard(numericCardRef);
  const [regeneratingTitle, setRegeneratingTitle] = useState(false);

  useEffect(() => {
    if (!cardStore.hydrated) return;
    const invalidCardRef = !Number.isFinite(numericCardRef) || numericCardRef <= 0 || !Number.isInteger(numericCardRef);

    if (!project || invalidCardRef || !card || card.projectId !== project.id) {
      navigate(project ? `/chat/${project.id}` : '/chat', { replace: true });
    }
  }, [card, cardStore.hydrated, navigate, numericCardRef, project]);

  // Type-to-focus: this page presents a single session — bare alphanumerics
  // focus the prompt and carry the typed character.
  const cardId = card?.id;
  useEffect(() => {
    if (cardId == null) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.repeat || !isTypeFocusKey(e)) return;
      if (isTypingContext(e.target)) return;
      e.preventDefault();
      dispatchTypeFocus(cardId!, e.key);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [cardId]);

  if (!project || !card || card.projectId !== project.id) return null;

  const activeCard = card;

  const regenerateTitle = async () => {
    const excerpt =
      recentUserText(sessionStore.getSession(activeCard.id)?.accumulator.conversation ?? []) ||
      activeCard.description.trim();
    if (!excerpt) return;
    setRegeneratingTitle(true);
    try {
      const title = await cardStore.suggestTitle(excerpt);
      if (title?.trim()) await cardStore.updateCard({ id: activeCard.id, title: title.trim() });
    } catch {
      // Keep the current title when the title gateway is unavailable.
    } finally {
      setRegeneratingTitle(false);
    }
  };

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
          actions={
            <button
              type="button"
              onClick={regenerateTitle}
              disabled={regeneratingTitle}
              aria-label="Regenerate title"
              title="Regenerate title from recent messages"
              className="flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-100"
            >
              <RefreshCw className={`size-3.5 ${regeneratingTitle ? 'animate-spin' : ''}`} />
            </button>
          }
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
        providerID={card.provider ?? project.providerID ?? 'anthropic'}
        thinkingLevel={card.thinkingLevel}
        summarizeThreshold={card.summarizeThreshold ?? 0}
        keepFocusAfterSend
      />
    </div>
  );
});

export default ChatCardView;
