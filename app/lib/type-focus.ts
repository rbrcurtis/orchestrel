// Type-to-focus: when a session is presented but its prompt isn't focused,
// typing an alphanumeric focuses the prompt and inserts that character, so
// the user can just keep typing. '/' stays reserved for search.

export const TYPE_FOCUS_EVENT = 'orchestrel:type-focus-prompt';

export type TypeFocusDetail = { cardId: number; char: string };

export function dispatchTypeFocus(cardId: number, char: string) {
  window.dispatchEvent(new CustomEvent<TypeFocusDetail>(TYPE_FOCUS_EVENT, { detail: { cardId, char } }));
}

export function isTypeFocusKey(e: KeyboardEvent) {
  return !e.ctrlKey && !e.metaKey && !e.altKey && /^[a-zA-Z0-9]$/.test(e.key);
}

/** True when the keypress belongs to something already taking text input —
 *  form fields, rich text, or Radix overlays (dialogs, open selects, menus)
 *  where bare characters have their own meaning (typeahead, shortcuts). */
export function isTypingContext(target: EventTarget | null) {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) {
    return true;
  }
  return !!el.closest('[role="dialog"], [role="listbox"], [role="menu"]');
}
