import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown } from 'lucide-react';
import { MessageBlock } from './MessageBlock';
import { ScrollArea } from '~/components/ui/scroll-area';
import type { ContentBlock, ConversationEntry } from '~/lib/message-accumulator';

export type VirtualTranscriptHandle = {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  isNearBottom: () => boolean;
};

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

const BOTTOM_GAP_PX = 120;
const SCROLL_BUTTON_GAP_PX = 60;
const EMPTY_HEIGHT_PX = 1;

function isNearBottom(el: HTMLDivElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_GAP_PX;
}

function scrollToBottom(el: HTMLDivElement, behavior: ScrollBehavior = 'auto') {
  el.scrollTo({
    top: el.scrollHeight,
    behavior,
  });
}

export const VirtualTranscript = forwardRef<VirtualTranscriptHandle, Props>(function VirtualTranscript(
  {
    cardId,
    conversation,
    currentBlocks,
    accentColor,
    historyLoaded,
    isStreaming,
    showScrollButton,
    onNearBottomChange,
    onShowScrollButtonChange,
  },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const prevItemsLenRef = useRef(0);
  const frameRef = useRef<number | null>(null);

  const items = useMemo<ConversationEntry[]>(() => {
    if (currentBlocks.length === 0) return conversation;
    return [
      ...conversation,
      { kind: 'blocks', blocks: currentBlocks },
    ];
  }, [conversation, currentBlocks]);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (idx) => {
      const item = items[idx];
      if (!item) return 72;
      if (item.kind === 'blocks') return 180;
      if (item.kind === 'tool_activity') return 220;
      if (item.kind === 'user') return 90;
      if (item.kind === 'result' || item.kind === 'compact' || item.kind === 'system') return 36;
      return 120;
    },
    overscan: 10,
  });

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

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = gap < BOTTOM_GAP_PX;
    nearBottomRef.current = nearBottom;
    onNearBottomChange?.(nearBottom);
    onShowScrollButtonChange(gap >= SCROLL_BUTTON_GAP_PX);
  }, [onNearBottomChange, onShowScrollButtonChange]);

  useImperativeHandle(ref, () => ({
    scrollToBottom(behavior: ScrollBehavior = 'auto') {
      if (items.length === 0) return;
      rowVirtualizer.scrollToIndex(items.length - 1, { align: 'end', behavior });
      scheduleScrollToBottom(behavior);
    },
    isNearBottom() {
      const el = scrollRef.current;
      if (!el) return true;
      return isNearBottom(el);
    },
  }), [items.length, rowVirtualizer, scheduleScrollToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener('scroll', updateScrollState, { passive: true });
    return () => el.removeEventListener('scroll', updateScrollState);
  }, [cardId, updateScrollState]);

  useEffect(() => {
    nearBottomRef.current = true;
    if (items.length === 0) return;
    rowVirtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    scheduleScrollToBottom();
    // Card switches need one bottom jump; later row growth is gated by the streaming effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);

  useEffect(() => {
    if (!historyLoaded || conversation.length === 0 || items.length === 0) return;
    nearBottomRef.current = true;
    rowVirtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    scheduleScrollToBottom();
    // History reloads need one bottom jump when loaded flips true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyLoaded]);

  useEffect(() => {
    if (items.length <= prevItemsLenRef.current) {
      prevItemsLenRef.current = items.length;
      return;
    }
    prevItemsLenRef.current = items.length;
    if (!isStreaming || !nearBottomRef.current || items.length === 0) return;
    rowVirtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    scheduleScrollToBottom();
  }, [items.length, isStreaming, rowVirtualizer, scheduleScrollToBottom]);

  useEffect(() => {
    if (!isStreaming || !nearBottomRef.current || items.length === 0) return;
    scheduleScrollToBottom();
  }, [currentBlocks, currentBlocks.length, isStreaming, items.length, scheduleScrollToBottom]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!isStreaming || !nearBottomRef.current || items.length === 0) return;
      scheduleScrollToBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isStreaming, items.length, scheduleScrollToBottom]);

  useEffect(() => () => cancelScheduledScroll(), [cancelScheduledScroll]);

  const measureRow = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const wasNearBottom = nearBottomRef.current;
    rowVirtualizer.measureElement(el);
    if (!isStreaming || !wasNearBottom) return;
    scheduleScrollToBottom();
  }, [isStreaming, rowVirtualizer, scheduleScrollToBottom]);

  const totalSize = Math.max(rowVirtualizer.getTotalSize(), EMPTY_HEIGHT_PX);

  return (
    <div className="relative flex-1 min-h-0 min-w-0">
      <ScrollArea
        viewportRef={scrollRef}
        viewportClassName="overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        className="h-full"
      >
        <div
          ref={contentRef}
          className="relative py-2 min-w-0 max-w-full overflow-x-hidden"
          style={{ height: totalSize }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index];
            if (!item) return null;
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={measureRow}
                className="absolute left-3 right-3 min-w-0"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <MessageBlock
                  entry={item}
                  index={virtualRow.index}
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
          onClick={() => {
            if (items.length === 0) return;
            rowVirtualizer.scrollToIndex(items.length - 1, { align: 'end', behavior: 'smooth' });
            scheduleScrollToBottom('smooth');
          }}
          className="absolute bottom-3 right-3 size-8 flex items-center justify-center rounded-full bg-muted/80 border border-border text-muted-foreground shadow-md backdrop-blur-sm hover:bg-muted hover:text-foreground transition-colors"
        >
          <ChevronDown className="size-4" />
        </button>
      )}
    </div>
  );
});
