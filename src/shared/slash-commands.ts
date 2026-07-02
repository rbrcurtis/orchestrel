// Pi's interactive TUI slash commands (e.g. `/compact`) are only interpreted by
// the Pi CLI front-end. Orchestrel runs Pi headless through orcd's SDK, where a
// typed message goes straight to the model as a prompt — so a user typing
// `/compact` in the chat box gets answered as plain text instead of compacting.
// Detect the commands we support here so callers can route them to the real
// signal instead of forwarding them to the model.

/** True when the prompt is the `/compact` command (optionally with trailing args). */
export function isCompactCommand(prompt: string): boolean {
  const t = prompt.trim();
  return t === '/compact' || t.startsWith('/compact ');
}
