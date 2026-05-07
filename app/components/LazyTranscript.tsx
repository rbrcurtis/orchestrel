import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MessageBlock } from './MessageBlock';
import { ScrollArea } from '~/components/ui/scroll-area';
import type { ContentBlock, ConversationEntry } from '~/lib/message-accumulator';

type Props = {
  cardId: number;
  conversation: ConversationEntry[];
  currentBlocks: ContentBlock[];
  accentColor?: string | null;
  historyLoaded: boolean;
  isStreaming: boolean;
  showScrollButton: boolean;
  onNearBottomChange?: (nearBottom: boolean) => void;
  onShowScrollButtonChange: (show: boolean) => void;
};

const INITIAL_ROWS = 120;
const ROW_BATCH = 80;
const TOP_LOAD_PX = 240;
const BOTTOM_GAP_PX = 120;
const SCROLL_BUTTON_GAP_PX = 60;

function scrollToBottom(el: HTMLDivElement, behavior: ScrollBehavior = 'auto') {
  el.scrollTo({
    top: el.scrollHeight,
    behavior,
  });
}

export function LazyTranscript({
  cardId,
  conversation,
  currentBlocks,
  accentColor,
  historyLoaded,
  isStreaming,
  showScrollButton,
  onNearBottomChange,
  onShowScrollButtonChange,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const prevItemsLenRef = useRef(0);
  const scrollMetricsRef = useRef<{ scrollHeight: number; scrollTop: number; clientHeight: number } | null>(null);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const hasOlderRef = useRef(false);
  const itemsLenRef = useRef(0);
  const prevHistoryLoadedRef = useRef(false);
  const initialBottomLockUntilRef = useRef(0);
  const [visibleCount, setVisibleCount] = useState(INITIAL_ROWS);

  const items = useMemo<ConversationEntry[]>(() => {
    if (currentBlocks.length === 0) return conversation;
    return [
      ...conversation,
      { kind: 'blocks', blocks: currentBlocks },
    ];
  }, [conversation, currentBlocks]);

  const startIndex = Math.max(0, items.length - visibleCount);
  const visibleItems = items.slice(startIndex);
  const hasOlder = startIndex > 0;
  hasOlderRef.current = hasOlder;
  itemsLenRef.current = items.length;

  const cancelScheduledScroll = useCallback(() => {
    if (frameRef.current == null) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const scheduleScrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    cancelScheduledScroll();
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      scrollToBottom(el, behavior);
    });
  }, [cancelScheduledScroll]);

  const loadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!hasOlderRef.current || prependAnchorRef.current) return;
    prependAnchorRef.current = {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
    setVisibleCount((count) => Math.min(itemsLenRef.current, count + ROW_BATCH));
  }, []);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const metrics = {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
    };
    scrollMetricsRef.current = metrics;

    const gap = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
    const nearBottom = gap < BOTTOM_GAP_PX;
    nearBottomRef.current = nearBottom;
    onNearBottomChange?.(nearBottom);
    onShowScrollButtonChange(gap >= SCROLL_BUTTON_GAP_PX);

    if (el.scrollTop <= TOP_LOAD_PX) loadOlder();
  }, [loadOlder, onNearBottomChange, onShowScrollButtonChange]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener('scroll', updateScrollState, { passive: true });
    return () => el.removeEventListener('scroll', updateScrollState);
  }, [cardId, updateScrollState]);

  useEffect(() => {
    setVisibleCount(INITIAL_ROWS);
    nearBottomRef.current = true;
    prevItemsLenRef.current = itemsLenRef.current;
    scrollMetricsRef.current = null;
    prependAnchorRef.current = null;
    prevHistoryLoadedRef.current = false;
    initialBottomLockUntilRef.current = Date.now() + 500;
    scheduleScrollToBottom();
  }, [cardId, scheduleScrollToBottom]);

  useEffect(() => {
    const wasLoaded = prevHistoryLoadedRef.current;
    prevHistoryLoadedRef.current = historyLoaded;
    if (wasLoaded || !historyLoaded || conversation.length === 0) return;
    setVisibleCount(INITIAL_ROWS);
    nearBottomRef.current = true;
    prevItemsLenRef.current = items.length;
    scrollMetricsRef.current = null;
    prependAnchorRef.current = null;
    initialBottomLockUntilRef.current = Date.now() + 500;
    scheduleScrollToBottom();
  }, [historyLoaded, conversation.length, items.length, scheduleScrollToBottom]);

  useEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor) return;
    const el = scrollRef.current;
    if (!el) return;
    prependAnchorRef.current = null;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
      updateScrollState();
    });
  }, [visibleCount, updateScrollState]);

  useEffect(() => {
    const previousLen = prevItemsLenRef.current;
    const nextLen = items.length;
    prevItemsLenRef.current = nextLen;
    if (nextLen <= previousLen) return;

    const metrics = scrollMetricsRef.current;
    const wasNearBottom = metrics
      ? metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < BOTTOM_GAP_PX
      : nearBottomRef.current;

    setVisibleCount((count) => Math.min(nextLen, count + nextLen - previousLen));
    if (isStreaming && wasNearBottom) scheduleScrollToBottom();
  }, [items.length, isStreaming, scheduleScrollToBottom]);

  useEffect(() => {
    if (!isStreaming || !nearBottomRef.current || items.length === 0) return;
    scheduleScrollToBottom();
  }, [currentBlocks, currentBlocks.length, isStreaming, items.length, scheduleScrollToBottom]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (items.length === 0) return;
      const withinInitialBottomLock = Date.now() < initialBottomLockUntilRef.current;
      if (withinInitialBottomLock) {
        scheduleScrollToBottom();
        return;
      }
      if (!isStreaming || !nearBottomRef.current) return;
      scheduleScrollToBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isStreaming, items.length, scheduleScrollToBottom]);

  useEffect(() => () => cancelScheduledScroll(), [cancelScheduledScroll]);

  return (
    <div className="relative flex-1 min-h-0 min-w-0">
      <ScrollArea
        viewportRef={scrollRef}
        viewportClassName="overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        className="h-full"
      >
        <div ref={contentRef} className="px-3 py-2 space-y-1 min-w-0 max-w-full">
          {hasOlder && (
            <div className="flex justify-center py-2">
              <button
                type="button"
                onClick={loadOlder}
                className="rounded border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-hover"
              >
                Load older
              </button>
            </div>
          )}
          {visibleItems.map((row, i) => {
            const index = startIndex + i;
            return (
              <div key={index} data-message-row>
                <MessageBlock
                  entry={row}
                  index={index}
                  accentColor={accentColor}
                />
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {!historyLoaded && conversation.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <svg className="size-6 animate-spin text-muted-foreground" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
      )}

      {showScrollButton && (
        <button
          type="button"
          onClick={() => scheduleScrollToBottom('smooth')}
          className="absolute bottom-3 right-3 size-8 flex items-center justify-center rounded-full bg-muted/80 border border-border text-muted-foreground shadow-md backdrop-blur-sm hover:bg-muted hover:text-foreground transition-colors"
        >
          <ChevronDown className="size-4" />
        </button>
      )}
    </div>
  );
}
