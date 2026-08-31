// Renderer memory diagnostics. Samples JS heap (performance.memory), DOM node
// count, and uptime once a minute and ships the line to the backend
// /api/pwa-log endpoint (Vite dev middleware → systemd journald), so any running
// instance captures its own growth curve for the Electron renderer memory-leak
// investigation. Each line carries a per-load session id + client tag so samples
// from different clients (Electron, Brave, Safari, phone PWA) can be separated.
//
// Note: Chromium's per-type memory breakdown (measureUserAgentSpecificMemory)
// was removed from Chrome; only performance.memory survives. JS-heap growth vs
// DOM/native growth is distinguished by tracking used/total heap alongside the
// DOM node count. Fire-and-forget: no deps, no state to clean up, best-effort.

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
    // beacon failure is fine — the sampler is best-effort
  }
}

let started = false;

export function startMemorySampling(intervalMs = 60_000): void {
  if (typeof window === 'undefined') return;
  // Survive HMR module re-evaluation: keep a single interval per page load.
  if (started) return;
  started = true;
  sample();
  setInterval(sample, intervalMs);
}
