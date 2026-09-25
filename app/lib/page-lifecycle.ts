// Tells a normal reload apart from a WebView the OS killed. A killed WebView
// fires no unload event, so the clean-exit marker stays unset and the next load
// reports the kill. This separates a Capacitor WKWebView termination (memory
// pressure) from a Vite or user reload.

const ALIVE_KEY = 'orchestrel:page-alive';
const CLEAN_KEY = 'orchestrel:page-clean';

function report(msg: string): void {
  try {
    navigator.sendBeacon('/api/pwa-log', JSON.stringify({ msg, ts: new Date().toISOString() }));
  } catch {
    // Diagnostics must not affect application behavior.
  }
}

export function trackPageLifecycle(): void {
  if (typeof window === 'undefined') return;
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const navType = nav?.type ?? 'unknown';
    const discarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true;
    const prevAlive = sessionStorage.getItem(ALIVE_KEY);
    const prevClean = sessionStorage.getItem(CLEAN_KEY);

    if (prevAlive !== '1') report(`page: first load in tab nav=${navType}`);
    else if (prevClean === '1') report(`page: previous page exited cleanly nav=${navType}`);
    else report(`page: previous page killed without unload nav=${navType} discarded=${discarded}`);

    sessionStorage.setItem(ALIVE_KEY, '1');
    sessionStorage.removeItem(CLEAN_KEY);

    // pagehide fires on reload, navigation, and tab close. It does not fire when
    // the OS kills the WebView process.
    window.addEventListener('pagehide', (e) => {
      if (e.persisted) return;
      try {
        sessionStorage.setItem(CLEAN_KEY, '1');
      } catch {
        // sessionStorage may be blocked. Diagnostics are optional.
      }
    });
  } catch {
    // sessionStorage may be blocked. Diagnostics are optional.
  }
}
