// Renderer memory diagnostics. Samples JS heap, DOM node count, and uptime once
// a minute and sends each sample to the existing backend log endpoint. A
// per-load ID and client tag separate concurrent browser and Electron clients.

interface HeapStatsApi {
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
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

function sample(): void {
  const uptimeSec = Math.round(performance.now() / 1000);
  const domNodes = document.querySelectorAll('*').length;
  const perf = performance as Performance & HeapStatsApi;
  const used = perf.memory ? mb(perf.memory.usedJSHeapSize) : -1;
  const total = perf.memory ? mb(perf.memory.totalJSHeapSize) : -1;
  const line = `mem sid=${sessionId} ua=${clientTag()} uptime=${uptimeSec}s used=${used}MB total=${total}MB dom=${domNodes}`;
  console.log(`[mem-sampler] ${line}`);
  try {
    navigator.sendBeacon('/api/pwa-log', JSON.stringify({ msg: line, ts: new Date().toISOString() }));
  } catch {
    // Diagnostics must not affect application behavior.
  }
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
