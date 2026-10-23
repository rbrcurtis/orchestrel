/**
 * Transcript media redaction.
 *
 * Pi persists image content as base64 inside the session file, so a session that
 * looked at a handful of photos carries tens of megabytes of image data in its
 * entries — one measured session was 46 MB, 45.3 MB of it 43 images. The UI never
 * renders those bytes (the agent reads the attachment from disk, and the transcript
 * only ever shows the user's text), yet every baseline, replay event and replica
 * copy carried them, so each snapshot moved tens of megabytes through orcd, the
 * backend and the browser.
 *
 * `redactInlineMedia` deep-copies a transcript projection value, replacing inline
 * image blocks with a plain text block. It is the clone used wherever a projection
 * or event is copied, so a redacted copy is the only copy that reaches the client.
 */

/** Text that stands in for an inline image block. */
export const IMAGE_OMITTED_TEXT = '[image omitted]';

/**
 * Deep-copy `value`, replacing inline image blocks with a text placeholder.
 *
 * Values that are not plain JSON (dates, class instances, maps) are returned as-is:
 * transcript payloads are JSON by construction, and this function is on the hot path
 * for multi-megabyte snapshot copies.
 */
export function redactInlineMedia<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => redactInlineMedia(item)) as T;
  if (!isPlainRecord(value)) return value;
  if (isInlineImage(value)) return { type: 'text', text: IMAGE_OMITTED_TEXT } as T;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) copy[key] = redactInlineMedia(item);
  return copy as T;
}

/** True when a content block carries inline base64 image data. */
export function isInlineImage(value: unknown): value is { type: 'image'; data: string; mimeType?: string } {
  return isPlainRecord(value) && value.type === 'image' && typeof value.data === 'string';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}
