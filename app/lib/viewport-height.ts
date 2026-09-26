// Keeps the app shell inside the visible area on iOS. When the keyboard or the
// iPad accessory bar appears, WebKit pans the visual viewport upward and shrinks
// it, even in a page that cannot scroll (WebKit bug 311821, a regression from
// iOS 18 that CSS alone cannot stop). WKWebView also leaves the layout height at
// the full frame, so the page gains a scroll range and WebKit scrolls the header
// off the top. Publishing both numbers lets the shell be pinned to the region the
// user actually sees.
//
//   --app-h    height of the visible area
//   --app-top  where the visible area starts inside the layout viewport
//
export function trackViewportHeight(): void {
  if (typeof window === 'undefined') return;
  const vv = window.visualViewport;
  // A stylesheet, not inline style on <html>: React hydrates <html>'s attributes
  // and reports a mismatch when they are set before hydration finishes.
  const sheet = document.createElement('style');
  sheet.dataset.viewportHeight = '';
  document.head.appendChild(sheet);

  function sync(): void {
    const h = Math.round(vv?.height ?? window.innerHeight);
    const top = Math.round(vv?.offsetTop ?? 0);
    sheet.textContent = `:root{--app-h:${h}px;--app-top:${top}px}`;
    // Clamp a scroll offset the browser set before the resize, but only when the
    // page has no room to scroll — other routes do scroll on purpose.
    const scroller = document.scrollingElement;
    if (scroller && scroller.scrollTop !== 0 && scroller.scrollHeight <= window.innerHeight + 1) {
      window.scrollTo(0, 0);
    }
  }

  sync();
  vv?.addEventListener('resize', sync);
  vv?.addEventListener('scroll', sync);
  window.addEventListener('resize', sync);
}
