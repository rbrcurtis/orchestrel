# File Upload for Claude Sessions

## Goal

Allow users to attach files (images, PDFs, docs, code) to chat messages so Claude can review them. Any file type supported, up to 25 MB per file, multiple files per message.

## Approach

Separate Express upload endpoint (`POST /api/upload`) with multer. Files saved to `/tmp/dispatcher-uploads/{sessionId}/`. tRPC `sendMessage` extended to accept file references. Server reads files from `/tmp`, builds Claude API content blocks, passes to SDK. Files are ephemeral — cleared on reboot.

## Upload Flow

1. User attaches files via paperclip button (bottom-right inside textarea), drag-and-drop, or clipboard paste
2. File chips appear above the textarea, right-aligned (left of stop button). Each chip has filename + remove button. Chips clear on send.
3. On send: files POST to `/api/upload` as multipart/form-data, returns file refs
4. tRPC `sendMessage` fires with `{ cardId, message, files?: FileRef[] }`
5. Server reads files from `/tmp`, builds content blocks array:
   - Images (png/jpg/gif/webp) → `{ type: 'image', source: { type: 'base64', media_type, data } }`
   - PDFs → `{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }`
   - Text/code → text content block with file contents
   - Other binary → text block noting file type not directly viewable
6. SDK receives content blocks via `sendUserMessage()`, handles persistence in its own session logs

## UI Details

### Prompt Input Area
- Paperclip icon button: absolutely positioned bottom-right inside textarea
- Drag-and-drop: drop zone overlay with subtle border highlight on drag-over
- Clipboard paste: handler on textarea intercepts image paste data
- File chip strip: above textarea, right-aligned, left of stop button
- Each chip: filename (truncated) + (x) remove button
- Chips cleared after message sends
- Client-side 25 MB per file validation

### Chat History (UserBlock)
- Images: inline thumbnail if file still exists in `/tmp`, otherwise "file no longer available" placeholder
- Non-images: compact filename chip with icon
- File metadata stored in user message content blocks — SDK handles persistence

## Server Changes

### New Express Route
- `POST /api/upload` — multer middleware, 25 MB limit
- Saves to `/tmp/dispatcher-uploads/{sessionId}/{uuid}-{originalname}`
- Returns `FileRef[]`: `{ id, name, mimeType, path }`

### tRPC Changes
- `sendMessage` input: add optional `files: z.array(fileRefSchema)`
- Build content blocks array from text + file refs
- Pass content blocks to `session.sendUserMessage()`

### protocol.ts
- `sendUserMessage()` accepts string | ContentBlock[] (currently string only)

## File Type Handling

| Type | MIME | Claude API Block |
|------|------|-----------------|
| Images | image/png, image/jpeg, image/gif, image/webp | `image` block with base64 source |
| PDFs | application/pdf | `document` block with base64 source |
| Text/code | text/*, application/json, application/xml, etc. | `text` block with file content |
| Other | anything else | `text` block noting filename and type |

## Not Building

- No database schema changes
- No persistent file storage (files in `/tmp`, gone on reboot)
- No file management UI
- No file type restrictions beyond 25 MB size limit
- No explicit cleanup (OS handles `/tmp`)
