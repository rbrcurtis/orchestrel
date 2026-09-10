// The browser writes both text/plain and text/html for a selection copy. Rich
// targets (email clients, docs) then paste the app's own styling — dark
// background, monospace code blocks, Tailwind classes baked into inline styles.
// Cancel the default copy and write the plain text only, so a paste anywhere
// looks like the text the user selected.
export function installPlainCopy(): void {
  const flagged = globalThis as Record<string, unknown>
  if (flagged.__plainCopyInstalled) return
  flagged.__plainCopyInstalled = true

  document.addEventListener('copy', (e) => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const text = sel.toString()
    if (!text) return
    e.preventDefault()
    e.clipboardData?.setData('text/plain', text)
  })
}
