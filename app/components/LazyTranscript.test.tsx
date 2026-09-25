/** @vitest-environment jsdom */
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LazyTranscript } from './LazyTranscript';
import type { ConversationEntry } from '~/lib/message-accumulator';

vi.mock('./MessageBlock', () => ({
  MessageBlock: ({ entry, index }: { entry: ConversationEntry; index: number }) => (
    <div data-testid="message-block" data-index={index}>
      {entry.kind === 'user' ? entry.content : entry.kind}
    </div>
  ),
}));

function conversation(count: number): ConversationEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'user',
    content: `Message ${i}`,
  }));
}

function setViewportMetrics(viewport: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollTop: { configurable: true, writable: true, value: metrics.scrollTop },
  });
}

describe('LazyTranscript auto-scroll', () => {
  let rafCallbacks: FrameRequestCallback[];
  let resizeObservers: ResizeObserverCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    resizeObservers = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeObservers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks[id - 1] = () => {};
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushAnimationFrames() {
    const callbacks = rafCallbacks;
    rafCallbacks = [];
    callbacks.forEach((callback) => callback(0));
  }

  function triggerResizeObservers() {
    resizeObservers.forEach((callback) => callback([] as ResizeObserverEntry[], {} as ResizeObserver));
  }

  it('does not scroll to bottom when a new entry arrives and the user has scrolled up', () => {
    const props = {
      cardId: 1,
      currentBlocks: [],
      accentColor: null,
      historyLoaded: true,
      showScrollButton: false,
      onShowScrollButtonChange: vi.fn(),
    };

    const { container, rerender } = render(
      <LazyTranscript {...props} conversation={conversation(3)} />,
    );
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
    const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options === 'object') viewport.scrollTop = Number(options.top);
    });
    viewport.scrollTo = scrollTo as HTMLDivElement['scrollTo'];

    // Drain initial-render scroll-to-bottom RAFs so they don't leak into the assertion.
    act(flushAnimationFrames);

    // User scrolls far from the bottom.
    setViewportMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
    act(() => viewport.dispatchEvent(new Event('scroll')));
    scrollTo.mockClear();

    // New committed entry arrives.
    setViewportMetrics(viewport, { scrollHeight: 1250, clientHeight: 400, scrollTop: 100 });
    rerender(<LazyTranscript {...props} conversation={conversation(4)} />);
    act(flushAnimationFrames);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('scrolls to the bottom when entries append while the reader is near the bottom', () => {
    const props = {
      cardId: 1,
      currentBlocks: [],
      accentColor: null,
      historyLoaded: true,
      showScrollButton: false,
      onShowScrollButtonChange: vi.fn(),
    };

    const { container, rerender } = render(
      <LazyTranscript {...props} conversation={conversation(3)} />,
    );
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
    const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options === 'object') viewport.scrollTop = Number(options.top);
    });
    viewport.scrollTo = scrollTo as HTMLDivElement['scrollTo'];
    setViewportMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 520 });
    act(() => viewport.dispatchEvent(new Event('scroll')));

    setViewportMetrics(viewport, { scrollHeight: 1250, clientHeight: 400, scrollTop: 520 });
    rerender(<LazyTranscript {...props} conversation={conversation(4)} />);
    act(flushAnimationFrames);

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1250, behavior: 'auto' });
    expect(screen.getAllByTestId('message-block')).toHaveLength(4);
  });

  it('pins to bottom when the reader sends a prompt after scrolling up', () => {
    const props = {
      cardId: 1,
      currentBlocks: [],
      accentColor: null,
      historyLoaded: true,
      showScrollButton: false,
      onShowScrollButtonChange: vi.fn(),
    };

    const { container, rerender } = render(
      <LazyTranscript {...props} conversation={conversation(3)} scrollToBottomSeq={0} />,
    );
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
    const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options === 'object') viewport.scrollTop = Number(options.top);
    });
    viewport.scrollTo = scrollTo as HTMLDivElement['scrollTo'];
    act(flushAnimationFrames);

    // Reader is high up in the log.
    setViewportMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
    act(() => viewport.dispatchEvent(new Event('scroll')));
    scrollTo.mockClear();

    // Sending a prompt bumps the sequence and appends the new user row.
    setViewportMetrics(viewport, { scrollHeight: 1250, clientHeight: 400, scrollTop: 100 });
    rerender(<LazyTranscript {...props} conversation={conversation(4)} scrollToBottomSeq={1} />);
    act(flushAnimationFrames);

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1250, behavior: 'auto' });
  });

  it('keeps transcript pinned to bottom while initial history content finishes sizing', () => {
    const props = {
      cardId: 1,
      currentBlocks: [],
      accentColor: null,
      historyLoaded: true,
      showScrollButton: false,
      onShowScrollButtonChange: vi.fn(),
    };

    const { container } = render(
      <LazyTranscript {...props} conversation={conversation(3)} />,
    );
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
    const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options === 'object') viewport.scrollTop = Number(options.top);
    });
    viewport.scrollTo = scrollTo as HTMLDivElement['scrollTo'];

    setViewportMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    act(flushAnimationFrames);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'auto' });

    scrollTo.mockClear();
    setViewportMetrics(viewport, { scrollHeight: 1400, clientHeight: 400, scrollTop: 600 });
    act(triggerResizeObservers);
    act(flushAnimationFrames);

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1400, behavior: 'auto' });
  });

  it('stays pinned when fast-growing content widens the gap past the threshold without user scrolling', () => {
    const props = {
      cardId: 1,
      currentBlocks: [],
      accentColor: null,
      historyLoaded: true,
      showScrollButton: false,
      onShowScrollButtonChange: vi.fn(),
    };

    const { container, rerender } = render(
      <LazyTranscript {...props} conversation={conversation(3)} />,
    );
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
    const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options === 'object') viewport.scrollTop = Number(options.top);
    });
    viewport.scrollTo = scrollTo as HTMLDivElement['scrollTo'];

    // At the bottom.
    setViewportMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    act(() => viewport.dispatchEvent(new Event('scroll')));

    // Bash output explodes: height jumps 500px before the scroll handler runs,
    // so the gap (500) is now past BOTTOM_GAP_PX — but the user did not scroll up.
    setViewportMetrics(viewport, { scrollHeight: 1500, clientHeight: 400, scrollTop: 600 });
    act(() => viewport.dispatchEvent(new Event('scroll')));
    scrollTo.mockClear();

    // Next committed entry must still pin to bottom.
    setViewportMetrics(viewport, { scrollHeight: 1600, clientHeight: 400, scrollTop: 600 });
    rerender(<LazyTranscript {...props} conversation={conversation(4)} />);
    act(flushAnimationFrames);

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1600, behavior: 'auto' });
  });

  it('pins to bottom for late content growth well after the initial lock, with no streaming', () => {
    const props = {
      cardId: 1,
      currentBlocks: [],
      accentColor: null,
      historyLoaded: true,
      showScrollButton: false,
      onShowScrollButtonChange: vi.fn(),
    };

    const { container, rerender } = render(
      <LazyTranscript {...props} conversation={conversation(3)} />,
    );
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
    const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options === 'object') viewport.scrollTop = Number(options.top);
    });
    viewport.scrollTo = scrollTo as HTMLDivElement['scrollTo'];

    // At the bottom after the initial load settled.
    setViewportMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    act(() => viewport.dispatchEvent(new Event('scroll')));
    act(flushAnimationFrames);
    scrollTo.mockClear();

    // Move past the 500ms initial bottom lock so it cannot account for the pin.
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 600);

    // The cache page renders, then newer turns arrive from the server.
    setViewportMetrics(viewport, { scrollHeight: 1500, clientHeight: 400, scrollTop: 600 });
    rerender(<LazyTranscript {...props} conversation={conversation(4)} />);
    act(triggerResizeObservers);
    act(flushAnimationFrames);

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1500, behavior: 'auto' });
    vi.restoreAllMocks();
  });

  it('does not pull the reader down when older history prepends at the top', () => {
    const props = {
      cardId: 1,
      currentBlocks: [],
      accentColor: null,
      historyLoaded: true,
      showScrollButton: false,
      onShowScrollButtonChange: vi.fn(),
    };

    const { container, rerender } = render(
      <LazyTranscript {...props} conversation={conversation(3)} />,
    );
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
    const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options === 'object') viewport.scrollTop = Number(options.top);
    });
    viewport.scrollTo = scrollTo as HTMLDivElement['scrollTo'];

    // Reader sits at the bottom of the loaded page.
    setViewportMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    act(() => viewport.dispatchEvent(new Event('scroll')));
    act(flushAnimationFrames);
    scrollTo.mockClear();

    // An older page prepends: same rows, plus earlier ones at the head.
    setViewportMetrics(viewport, { scrollHeight: 1250, clientHeight: 400, scrollTop: 600 });
    rerender(
      <LazyTranscript {...props} conversation={[{ kind: 'user', content: 'Older message' }, ...conversation(3)]} />,
    );
    act(flushAnimationFrames);

    expect(scrollTo).not.toHaveBeenCalled();
  });
});

// The top sentinel pages older history in automatically. Guarding against the
// initial mount (viewport at scrollTop 0) matters: without it, every card open
// would fetch the whole history instead of waiting for a scroll-up.
describe('LazyTranscript infinite scroll', () => {
  class FakeIntersectionObserver {
    static instances: FakeIntersectionObserver[] = [];
    callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      FakeIntersectionObserver.instances.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    trigger(el: Element, isIntersecting: boolean) {
      this.callback(
        [{ target: el, isIntersecting } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
  }

  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks[id - 1] = () => {};
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pages older history only after the reader scrolls up', () => {
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <LazyTranscript
        cardId={1}
        conversation={conversation(3)}
        currentBlocks={[]}
        accentColor={null}
        historyLoaded
        showScrollButton={false}
        hasOlderHistory
        onLoadOlderHistory={onLoadOlderHistory}
        onShowScrollButtonChange={vi.fn()}
      />,
    );
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
    viewport.scrollTo = vi.fn() as HTMLDivElement['scrollTo'];
    act(() => rafCallbacks.splice(0).forEach((callback) => callback(0)));
    const top = container.querySelector('[data-testid="transcript-top-sentinel"]') as Element;
    const observer = FakeIntersectionObserver.instances.at(-1)!;

    // Opening the card leaves scrollTop at the top, but the transcript overflows
    // and is pinned to the bottom: the sentinel must not page yet.
    setViewportMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    act(() => observer.trigger(top, true));
    expect(onLoadOlderHistory).not.toHaveBeenCalled();

    // A real scroll-up unlocks paging.
    setViewportMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    act(() => viewport.dispatchEvent(new Event('scroll')));
    setViewportMetrics(viewport, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
    act(() => viewport.dispatchEvent(new Event('scroll')));
    act(() => observer.trigger(top, true));
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });
});
