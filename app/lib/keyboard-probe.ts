// Reports what moves when the iOS keyboard shortcut bar appears. Logs the
// header's position, the document scroll offset, and the visual viewport, and
// only when one of them changes, so a quiet journal means nothing moved. Samples
// again shortly after each change because iOS animates the keyboard transition.
function report(msg: string): void {
  try {
    navigator.sendBeacon('/api/pwa-log', JSON.stringify({ msg, ts: new Date().toISOString() }));
  } catch {
    // Diagnostics must not affect application behavior.
  }
}

export function trackKeyboardShift(): void {
  if (typeof window === 'undefined') return;
  const vv = window.visualViewport;
  const d = document.documentElement;
  let prev = '';

  function snap(reason: string): void {
    const header = document.querySelector('header');
    const rect = header?.getBoundingClientRect();
    const bodyTop = Math.round(document.body.getBoundingClientRect().top);
    const geo = `headerTop=${rect ? Math.round(rect.top) : -1} headerH=${rect ? Math.round(rect.height) : -1} bodyTop=${bodyTop} innerH=${window.innerHeight} scrollY=${Math.round(window.scrollY)} docH=${d.scrollHeight} docClientH=${d.clientHeight} vvH=${vv ? Math.round(vv.height) : -1} vvTop=${vv ? Math.round(vv.offsetTop) : -1} scale=${vv ? vv.scale.toFixed(2) : '-'} active=${document.activeElement?.tagName ?? '-'}`;
    if (geo === prev) return;
    prev = geo;
    report(`kb ${reason} ${geo}`);
    if (reason.endsWith('+')) return;
    setTimeout(() => snap(`${reason}+300`), 300);
    setTimeout(() => snap(`${reason}+1200`), 1200);
  }

  vv?.addEventListener('resize', () => snap('vv-resize'));
  vv?.addEventListener('scroll', () => snap('vv-scroll'));
  window.addEventListener('scroll', () => snap('scroll'));
  document.addEventListener('focusin', () => snap('focusin'));
  document.addEventListener('focusout', () => snap('focusout'));
}
