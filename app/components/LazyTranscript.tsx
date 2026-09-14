import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MessageBlock } from './MessageBlock';
import { ScrollArea } from '~/components/ui/scroll-area';
import type { ContentBlock, ConversationEntry } from '~/lib/message-accumulator';

type Props = {
  cardId: number;
  hasNewerHistory?: boolean;
  onLoadNewerHistory?: () => Promise<void>;
  hasOlderHistory?: boolean;
  onLoadOlderHistory?: () => Promise<void>;
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
  hasNewerHistory = false,
  onLoadNewerHistory,
  hasOlderHistory = false,
  onLoadOlderHistory,
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
  const streamEndLockUntilRef = useRef(0);
  const prevIsStreamingRef = useRef(isStreaming);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const topVisibleRef = useRef(false);
  const bottomVisibleRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const userScrolledRef = useRef(false);
  const [visibleCount, setVisibleCount] = useState(INITIAL_ROWS);
  const visibleCountRef = useRef(visibleCount);
  visibleCountRef.current = visibleCount;
  const hasOlderHistoryRef = useRef(hasOlderHistory);
  hasOlderHistoryRef.current = hasOlderHistory;
  const hasNewerHistoryRef = useRef(hasNewerHistory);
  hasNewerHistoryRef.current = hasNewerHistory;
  const onLoadOlderHistoryRef = useRef(onLoadOlderHistory);
  onLoadOlderHistoryRef.current = onLoadOlderHistory;
  const onLoadNewerHistoryRef = useRef(onLoadNewerHistory);
  onLoadNewerHistoryRef.current = onLoadNewerHistory;

  const items = useMemo<ConversationEntry[]>(() => {
    if (currentBlocks.length === 0) return conversation;
    return [
      ...conversation,
      { kind: 'blocks', blocks: currentBlocks },
    ];
  }, [conversation, currentBlocks]);

  const startIndex = Math.max(0, items.length - visibleCount);
  const visibleItems = items.slice(startIndex);

  // Group rows into chunks led by a user message. The user row sticks to the
  // top while its chunk is visible; the next chunk's user row pushes the
  // previous one off as you scroll, in either direction.
  const segments = useMemo(() => {
    const segs: { index: number; entry: ConversationEntry }[][] = [];
    let current: { index: number; entry: ConversationEntry }[] | null = null;
    visibleItems.forEach((entry, i) => {
      if (entry.kind === 'user' || !current) {
        current = [];
        segs.push(current);
      }
      current.push({ index: startIndex + i, entry });
    });
    return segs;
  }, [visibleItems, startIndex]);
  const hasOlder = startIndex > 0 || hasOlderHistory;
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
    if (!hasOlderRef.current || loadingOlderRef.current) return;
    // A viewport taller than its content has no scroll gesture to trigger the
    // observer, so fill it. Otherwise only page older history when the reader
    // scrolled up themselves — never while pinned to the initial bottom.
    const overflowing = el.scrollHeight > el.clientHeight + 1;
    if (overflowing && !userScrolledRef.current) return;
    const anchor = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    // Rows already loaded above the window are revealed first; once the window
    // covers every loaded row, fetch the next older page. The anchor keeps the
    // reader's place while either prepend happens.
    if (visibleCountRef.current >= itemsLenRef.current && hasOlderHistoryRef.current && onLoadOlderHistoryRef.current) {
      const before = itemsLenRef.current;
      loadingOlderRef.current = true;
      prependAnchorRef.current = anchor;
      void Promise.resolve(onLoadOlderHistoryRef.current()).finally(() => {
        loadingOlderRef.current = false;
        // A page that yielded no rows never triggers the visible-count effect,
        // so release the anchor to allow a later retry.
        if (itemsLenRef.current === before) prependAnchorRef.current = null;
      });
      return;
    }
    prependAnchorRef.current = anchor;
    setVisibleCount((count) => Math.min(itemsLenRef.current, count + ROW_BATCH));
  }, []);

  const loadNewer = useCallback(() => {
    if (!hasNewerHistoryRef.current || loadingNewerRef.current || !onLoadNewerHistoryRef.current) return;
    loadingNewerRef.current = true;
    void Promise.resolve(onLoadNewerHistoryRef.current()).finally(() => {
      loadingNewerRef.current = false;
    });
  }, []);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const metrics = {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
    };

    const gap = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
    let nearBottom = gap < BOTTOM_GAP_PX;
    // Fast-growing content (e.g. bash output) can widen the gap past the
    // threshold between our programmatic scrollTo and this handler running.
    // Only unstick when the user actually scrolled up — content growth alone
    // must not cancel bottom-following.
    const prev = scrollMetricsRef.current;
    if (!nearBottom && nearBottomRef.current && prev) {
      const heightGrew = metrics.scrollHeight > prev.scrollHeight;
      const scrolledUp = metrics.scrollTop < prev.scrollTop;
      if (heightGrew && !scrolledUp) nearBottom = true;
    }
    // Only an actual scroll-up (not a programmatic bottom pin or prepend
    // anchor) unlocks paging older history via the top sentinel.
    if (prev && metrics.scrollTop < prev.scrollTop) userScrolledRef.current = true;
    scrollMetricsRef.current = metrics;
    nearBottomRef.current = nearBottom;
    onNearBottomChange?.(nearBottom);
    onShowScrollButtonChange(gap >= SCROLL_BUTTON_GAP_PX);
  }, [onNearBottomChange, onShowScrollButtonChange]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener('scroll', updateScrollState, { passive: true });
    return () => el.removeEventListener('scroll', updateScrollState);
  }, [cardId, updateScrollState]);

  // Infinite scroll: sentinels at both ends of the transcript fetch the next
  // page as they enter the viewport, replacing the old load-more buttons.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const root = scrollRef.current;
    const top = topSentinelRef.current;
    const bottom = bottomSentinelRef.current;
    if (!root || !top || !bottom) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === top) {
          topVisibleRef.current = entry.isIntersecting;
          if (entry.isIntersecting) loadOlder();
        } else if (entry.target === bottom) {
          bottomVisibleRef.current = entry.isIntersecting;
          if (entry.isIntersecting) loadNewer();
        }
      }
    }, { root, rootMargin: `${TOP_LOAD_PX}px 0px ${TOP_LOAD_PX}px 0px` });
    observer.observe(top);
    observer.observe(bottom);
    return () => observer.disconnect();
  }, [loadOlder, loadNewer]);

  // IntersectionObserver only fires on threshold crossings. When a page load
  // leaves the sentinel in view (transcript still shorter than the viewport, or
  // another unfilled page), re-run the load until the view overflows or the
  // history is exhausted.
  useEffect(() => {
    if (topVisibleRef.current) loadOlder();
    if (bottomVisibleRef.current) loadNewer();
  }, [items.length, visibleCount, hasOlderHistory, hasNewerHistory, loadOlder, loadNewer]);

  useEffect(() => {
    setVisibleCount(INITIAL_ROWS);
    nearBottomRef.current = true;
    userScrolledRef.current = false;
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

  // When a turn ends, isStreaming flips false while late content (final bash
  // output, markdown paint) may still grow the transcript. Hold a short bottom
  // lock so those late resizes still land at the bottom.
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;
    if (!wasStreaming || isStreaming) return;
    if (!nearBottomRef.current) return;
    streamEndLockUntilRef.current = Date.now() + 800;
    scheduleScrollToBottom();
  }, [isStreaming, scheduleScrollToBottom]);

  useEffect(() => {
    const previousLen = prevItemsLenRef.current;
    const nextLen = items.length;
    prevItemsLenRef.current = nextLen;
    if (nextLen <= previousLen) return;

    const wasNearBottom = nearBottomRef.current;

    setVisibleCount((count) => Math.min(nextLen, count + nextLen - previousLen));
    const withinStreamEndLock = Date.now() < streamEndLockUntilRef.current;
    if ((isStreaming || withinStreamEndLock) && wasNearBottom) scheduleScrollToBottom();
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
      const withinStreamEndLock = Date.now() < streamEndLockUntilRef.current;
      if (withinStreamEndLock && nearBottomRef.current) {
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
          <div ref={topSentinelRef} className="h-px" data-testid="transcript-top-sentinel" aria-hidden="true" />
          {segments.map((rows) => (
            <div key={rows[0].index} className="space-y-1">
              {rows.map(({ index, entry }, j) => (
                <div
                  key={index}
                  data-message-row
                  className={j === 0 && entry.kind === 'user' ? 'sticky top-0 z-10 bg-card/95 py-1 backdrop-blur-sm' : undefined}
                >
                  <MessageBlock
                    entry={entry}
                    index={index}
                    accentColor={accentColor}
                  />
                </div>
              ))}
            </div>
          ))}
          <div ref={bottomSentinelRef} className="h-px" data-testid="transcript-bottom-sentinel" aria-hidden="true" />
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
