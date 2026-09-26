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
  const line = `mem sid=${sessionId} ua=${clientTag()} uptime=${uptimeSec}s used=${used}MB total=${total}MB dom=${domNodes}${ios}`;
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
