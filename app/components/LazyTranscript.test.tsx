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
      isStreaming: true,
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

  it('scrolls to the bottom when streaming appends content while already near the bottom', () => {
    const props = {
      cardId: 1,
      currentBlocks: [],
      accentColor: null,
      historyLoaded: true,
      isStreaming: true,
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

  it('keeps transcript pinned to bottom while initial history content finishes sizing', () => {
    const props = {
      cardId: 1,
      currentBlocks: [],
      accentColor: null,
      historyLoaded: true,
      isStreaming: false,
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
});
