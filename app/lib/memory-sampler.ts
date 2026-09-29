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

if (typeof window !== 'undefined') {
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
  window.addEventListener('click', () => (pointer.click += 1), true);
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
  const line = `mem sid=${sessionId} ua=${clientTag()} uptime=${uptimeSec}s used=${used}MB total=${total}MB dom=${domNodes}${ios}${cache}${hold} ${uiState()}`;
  console.log(`[mem-sampler] ${line}`);
  report(line);
}

let started = false;

export function startMemorySampling(intervalMs = 60_000): void {
  if (typeof window === 'undefined') return;
  // Keep one interval when Vite evaluates this module again during HMR.
  if (started) return;
  started = true;
  sample();
  setInterval(sample, intervalMs);
}
