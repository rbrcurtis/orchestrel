// Renderer memory diagnostics. Samples JS heap, DOM node count, and uptime once
// a minute and sends each sample to the existing backend log endpoint. A
// per-load ID and client tag separate concurrent browser and Electron clients.

interface HeapStatsApi {
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
}

// Numbers the iOS shell pushes in from a native timer. WKWebView has no
// performance.memory, so on the phone this is the only memory figure we can get.
interface IosMemoryStats {
  available: number;
  total: number;
  up: number; // seconds since the native app launched
  warn: number; // memory warnings the OS sent this launch
  sysFree: number; // free memory across the whole device
  event?: string; // set on a one-off line (bg, fg, warn) instead of a sample
}

const globalWithIosHook = globalThis as typeof globalThis & {
  __iosMemory?: (stats: IosMemoryStats) => void;
};
let iosMemory: IosMemoryStats | null = null;
if (typeof window !== 'undefined') {
  globalWithIosHook.__iosMemory = (stats) => {
    // An event lands the moment it happens and reports itself at once: the next
    // periodic sample can be a minute away, and the WebView may not live that
    // long. "bg" and "fg" show whether a reclaim happened while the app was in
    // the background; "warn" shows the OS already asked for memory.
    if (stats.event) {
      report(
        `ios-${stats.event} iosUp=${stats.up}s iosAvail=${mb(stats.available)}MB sysFree=${mb(stats.sysFree)}MB iosWarn=${stats.warn}`,
      );
      return;
    }
    iosMemory = stats;
  };
}

const sessionId = typeof window !== 'undefined' ? Math.random().toString(36).slice(2, 8) : 'none';

function mb(bytes: number): number {
  return Math.round(bytes / 1_048_576);
}

function clientTag(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Electron')) return 'electron';
  if (ua.includes('Brave')) return 'brave';
  if (ua.includes('Chrome')) return 'chrome';
  if (ua.includes('Safari')) return 'safari';
  return 'other';
}

// Whether the page would still accept a click. When the app looks normal but nothing
// responds, either the page is not listening or something is sitting on top of it,
// and these figures separate the two: a locked pointer, a popover or dialog left
// mounted, and whatever element actually owns the centre of the screen.
function uiState(): string {
  const bodyPe = getComputedStyle(document.body).pointerEvents;
  const htmlPe = getComputedStyle(document.documentElement).pointerEvents;
  const open = document.querySelectorAll('[data-state="open"]').length;
  const layers = document.querySelectorAll(
    '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], [offcanvas]',
  ).length;
  const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  const hitTag = hit
    ? `${hit.tagName.toLowerCase()}${hit.getAttribute('data-testid') ? '#' + hit.getAttribute('data-testid') : ''}`
    : 'null';
  const active = document.activeElement ? document.activeElement.tagName.toLowerCase() : 'none';
  return `ui bodyPe=${bodyPe} htmlPe=${htmlPe} open=${open} layers=${layers} hit=${hitTag} focus=${active} ${pointerState()}`;
}

// A click that never arrives is invisible from inside React, so count the raw events.
// A pointer that went down and never came up, or pointer downs that never became
// clicks, means the event was consumed before it reached the handler - which is what a
// drag sensor left listening after its item unmounted looks like.
const pointer = { down: 0, up: 0, cancel: 0, click: 0, last: 'none' };

function pointerState(): string {
  return `pt down=${pointer.down} up=${pointer.up} cancel=${pointer.cancel} click=${pointer.click} last=${pointer.last}`;
}

// Errors have nowhere to go from the page: the renderer console is not visible from
// the server, and a handler that throws looks exactly like a page that stopped
// responding. Each error is reported as it happens, and the newest one rides on the
// sampler line so a failure that lasts a second is still visible afterwards.
const clientErrors: string[] = [];

function noteError(kind: string, detail: string): void {
  const msg = `${kind} ${detail}`.replace(/\s+/g, ' ').slice(0, 200);
  clientErrors.push(msg);
  if (clientErrors.length > 4) clientErrors.shift();
  report(`client-error ${msg} ${uiState()}`);
}

function errorState(): string {
  if (clientErrors.length === 0) return 'err=0';
  return `err=${clientErrors.length}:${clientErrors[clientErrors.length - 1]}`;
}

// A page that stops updating while its timers keep running has lost frames, not work.
// The animation frame counter separates the two. If uptime keeps climbing while
// frameIdle grows, JavaScript is alive and the compositor stopped presenting, which is
// what an exhausted raster tile budget looks like. A hidden window throttles frames,
// so read this next to hit= and the window state.
const frames = { count: 0, lastAt: 0, gapMs: 0 };

if (typeof window !== 'undefined' && typeof requestAnimationFrame === 'function') {
  const tick = (t: number) => {
    frames.count += 1;
    if (frames.lastAt) frames.gapMs = Math.round(t - frames.lastAt);
    frames.lastAt = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function frameState(): string {
  const idle = frames.lastAt ? Math.round(performance.now() - frames.lastAt) : -1;
  return `frames=${frames.count} frameGap=${frames.gapMs}ms frameIdle=${idle}ms ${longTaskState()}`;
}

// The main thread is what makes the app feel dead: a long task blocks clicks, layout and
// painting together while the timers that report on it keep running. The browser
// reports every task over 50 ms, which is the measurement that was missing - the store
// only counted the JavaScript it does itself, not the rendering it causes.
const longTasks = { count: 0, maxMs: 0, totalMs: 0, lastMs: 0 };

if (typeof window !== 'undefined' && typeof PerformanceObserver === 'function') {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ms = Math.round(entry.duration);
        longTasks.count += 1;
        longTasks.totalMs += ms;
        longTasks.lastMs = ms;
        if (ms > longTasks.maxMs) longTasks.maxMs = ms;
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    // Not every engine exposes it; the rest of the sample still works.
  }
}

function longTaskState(): string {
  return `long=${longTasks.count} longMax=${longTasks.maxMs}ms longLast=${longTasks.lastMs}ms longTotal=${longTasks.totalMs}ms`;
}

// What the store is holding, without the paint counter: the paint loop advances on its
// own, so it cannot serve as evidence that a click did anything.
function storeSignature(): string {
  const diag = (
    globalThis as { __rootStore?: { sessions?: { diagStats?: () => Record<string, number> } } }
  ).__rootStore?.sessions?.diagStats?.();
  if (!diag) return 'none';
  return `cards=${diag.cards} loads=${diag.cardLoads} viewers=${diag.viewers} hist=${diag.historyMessages} pages=${diag.historyPages}`;
}

function describeTarget(el: HTMLElement): string {
  const testid = el.getAttribute('data-testid');
  const cls = typeof el.className === 'string' ? el.className.split(' ').slice(0, 2).join('.') : '';
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
  return `${el.tagName.toLowerCase()}${testid ? '#' + testid : ''}${cls ? '.' + cls : ''}${text ? ` "${text}"` : ''}`;
}

// The instrumentation below is answered by a report to the server. Where that is
// impossible - a test runner has no sendBeacon - it installs nothing, so it cannot
// hold a timer open against a teardown or add noise to a test.
const canReport = typeof window !== 'undefined' && typeof navigator.sendBeacon === 'function';

if (canReport) {
  window.addEventListener(
    'pointerdown',
    (e) => {
      pointer.down += 1;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const name = t ? (t.getAttribute('data-testid') ?? t.tagName.toLowerCase()) : '?';
      pointer.last = `${name}@${Math.round(e.clientX)},${Math.round(e.clientY)}`;
    },
    true,
  );
  window.addEventListener('pointerup', () => (pointer.up += 1), true);
  window.addEventListener('pointercancel', () => (pointer.cancel += 1), true);

  // Reported at the moment it happens, because the whole symptom is short: the page
  // answered the click and nothing changed. The signature is read again a second
  // later, so a click that reached a dead handler is recorded with the state it left
  // behind rather than waiting up to a minute for the next sample.
  window.addEventListener(
    'click',
    (e) => {
      pointer.click += 1;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const where = t ? describeTarget(t) : '?';
      const before = storeSignature();
      report(`click on=${where} at=${Math.round(e.clientX)},${Math.round(e.clientY)} sig=${before} ${uiState()}`);
      setTimeout(() => {
        const after = storeSignature();
        if (after === before) report(`click-dead on=${where} sig=${after} ${uiState()}`);
      }, 1_200);
    },
    true,
  );

  window.addEventListener('error', (e) => noteError('error', e.message || String(e)));
  window.addEventListener('unhandledrejection', (e) =>
    noteError('reject', String((e as PromiseRejectionEvent).reason)),
  );
}

function report(line: string): void {
  try {
    navigator.sendBeacon('/api/pwa-log', JSON.stringify({ msg: line, ts: new Date().toISOString() }));
  } catch {
    // Diagnostics must not affect application behavior.
  }
}

function sample(): void {
  const uptimeSec = Math.round(performance.now() / 1000);
  const domNodes = document.querySelectorAll('*').length;
  const perf = performance as Performance & HeapStatsApi;
  const used = perf.memory ? mb(perf.memory.usedJSHeapSize) : -1;
  const total = perf.memory ? mb(perf.memory.totalJSHeapSize) : -1;
  const ios = iosMemory
    ? ` iosAvail=${mb(iosMemory.available)}MB iosTotal=${mb(iosMemory.total)}MB iosUp=${iosMemory.up}s iosWarn=${iosMemory.warn} sysFree=${mb(iosMemory.sysFree)}MB`
    : '';
  // A page read that returns the page the client asked for is a hit; a read that
  // returns nothing or a page for another session is a miss. liveWrite counts the
  // cached live replicas, and liveHit the returns that started from one.
  const stats = (globalThis as { __rootStore?: { sessions?: { cacheStats?: Record<string, number> } } }).__rootStore
    ?.sessions?.cacheStats;
  const cache = stats
    ? ` cachePageRead=${stats.pageRead} cachePageHit=${stats.pageHit} cachePageMiss=${stats.pageMiss} cacheLiveRead=${stats.liveRead} cacheLiveFound=${stats.liveFound} cacheLiveWrite=${stats.liveWrite} cacheLiveHit=${stats.liveHit}`
    : '';
  // What the client is holding, and how much painting it is doing. The renderer's
  // memory sits outside all of these, so comparing the two lines is the measurement.
  const diag = (
    globalThis as { __rootStore?: { sessions?: { diagStats?: () => Record<string, number> } } }
  ).__rootStore?.sessions?.diagStats?.();
  const hold = diag
    ? ` paint=${diag.paintCostMs}ms paints=${diag.paints} loads=${diag.cardLoads} evict=${diag.evictions} stuck=${diag.stuckReleases} cards=${diag.cards} replicas=${diag.replicas} hist=${diag.historyMessages} pages=${diag.historyPages} viewers=${diag.viewers} liveBuf=${diag.liveBuffers}`
    : '';
  const line = `mem sid=${sessionId} ua=${clientTag()} uptime=${uptimeSec}s used=${used}MB total=${total}MB dom=${domNodes}${ios}${cache}${hold} ${uiState()} ${frameState()} ${errorState()}`;
  console.log(`[mem-sampler] ${line}`);
  report(line);
}

let started = false;

export function startMemorySampling(intervalMs = 60_000): void {
  // Nothing to report with, and a timer that cannot report only leaves work behind for
  // a test runner's teardown. A browser and the Electron page both have sendBeacon.
  if (!canReport) return;
  // Keep one interval when Vite evaluates this module again during HMR.
  if (started) return;
  started = true;
  sample();
  setInterval(sample, intervalMs);
}
