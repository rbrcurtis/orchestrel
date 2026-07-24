# iOS Share-to-Orchestrel Design

## Goal

Add Orchestrel and Orc Chat to the iOS share sheet. Sharing text, a URL, images, or files opens the appropriate existing draft UI with the shared content prefilled but does not create anything until the user submits.

The user experience should match pasting into the existing session composer:

- shared text and URLs appear in the editable textarea;
- shared images and files appear as removable attachment chips above the textarea;
- the user can add commentary before saving the card or starting the chat;
- cancelling leaves no card, chat, or server upload behind.

## Product Behavior

### Orchestrel

Selecting Orchestrel in the share sheet opens the app and presents the standard new-card UI. The existing project selector, title suggestion, status, model, worktree, and other card fields continue to work normally.

The shared text or URL initializes the description. Shared files initialize the attachment list. The user chooses a project, edits the description, supplies or generates a title, and explicitly saves.

### Orc Chat

Selecting Orc Chat opens its standard new-chat UI for project `19`, which is the project wrapped by the current app configuration. Shared text or URLs initialize the prompt and shared files initialize the attachment list. The user adds commentary and explicitly starts the chat.

The project remains a configuration concern of the Orc Chat wrapper. The first implementation does not add a native project picker or dynamically discover a project in the Share Extension.

### Shared item handling

One share operation may contain multiple provider items:

- Plain text is inserted into the textarea.
- URLs are inserted as plain URL text into the textarea.
- If both text and URL values are present, distinct values are joined with blank lines in provider order.
- Images and arbitrary files become attachments and retain their source filename and MIME/UTType when available.
- Duplicate text values and duplicate files from the same share request are ignored.
- Each file is limited to 25 MB, matching the existing upload limit.
- Unsupported, unreadable, or oversized items are reported inline without discarding valid items from the same share.

Shared content never automatically creates a card, starts a session, or uploads a file.

## Architecture

### Native Share Extensions

Each app receives an independent iOS Share Extension target in its existing Xcode project:

| App | Bundle ID | Share Extension bundle ID | App Group | URL scheme |
| --- | --- | --- | --- | --- |
| Orchestrel | `com.orchestrel.ios` | `com.orchestrel.ios.share` | `group.com.orchestrel.ios.share` | `orchestrel` |
| Orc Chat | `com.orchestrel.orcchat.ios` | `com.orchestrel.orcchat.ios.share` | `group.com.orchestrel.orcchat.ios.share` | `orcchat` |

The extensions accept public URL, plain text, image, and file representations. An extension normalizes all accepted items into one inbox entry, copies file data into its App Group container, writes the manifest atomically, and opens the containing app through the app-specific URL scheme.

A Share Extension has no App-Store-supported API for launching its containing app. The implementation will use the established responder-chain `openURL:` handoff after the manifest is committed. This is suitable for the current private distribution workflow but carries App Store review risk. If public App Store distribution becomes a requirement, the extension must instead finish with an explicit confirmation UI and let the user launch the app separately; the App Group inbox and all downstream behavior remain unchanged.

Each app and its extension use a separate App Group. Content cannot leak between the full app and Orc Chat, and the same implementation can be copied with app-specific identifiers and destinations.

### App Group inbox

An inbox entry is a directory identified by a UUID:

```text
Inbox/<share-id>/
  manifest.json
  files/
    <file-id>-<sanitized-name>
```

The manifest contains:

```ts
type SharedDraftManifest = {
  version: 1;
  id: string;
  createdAt: string;
  text: string;
  files: Array<{
    id: string;
    name: string;
    mimeType: string;
    relativePath: string;
    size: number;
  }>;
  errors: string[];
};
```

The manifest is first written under a temporary name and renamed only after all file copies finish. This prevents the app from reading a partially written share.

### Native-to-web bridge

Each containing app adds a small local Capacitor plugin named `SharedDraft`. It exposes:

- `list()` — returns pending manifest summaries in creation order;
- `read({ id })` — returns text, errors, and files as WebView-accessible file URLs;
- `acknowledge({ id })` — removes the inbox directory after React has safely persisted the draft;
- `discard({ id })` — removes an explicitly cancelled pending share.

The plugin emits `sharedDraftReceived` when the app receives a share deep link while already running. On cold launch, React calls `list()` after Capacitor is ready rather than relying on an event emitted before the listener exists.

The plugin does not upload files and does not create cards. Its only responsibility is safe delivery from the App Group inbox into the WebView.

### Browser File conversion

The React integration reads each WebView-accessible file URL, fetches its bytes, and constructs a browser `File` with the manifest filename and MIME type. From that point onward, shared files follow the same browser-side path as files pasted, dropped, or chosen in an existing session.

This conversion is bounded by the 25 MB per-file limit. A conversion failure is shown on the draft while other valid files remain usable.

## Web Draft Integration

### Shared attachment composer

Extract the existing file-selection behavior from `SessionView` into a focused attachment composer primitive used by:

- the existing session composer;
- `NewCardDetail`;
- the new-chat composer in `chat.$projectId.tsx`.

The shared behavior includes:

- attachment chips with filename and size;
- remove controls;
- file picker support;
- image paste support;
- drag-and-drop support where already available;
- the 25 MB per-file check;
- upload progress and inline errors.

The component owns presentation and local `File[]` manipulation. Parent screens retain ownership of textarea content and submission workflow.

### Draft persistence and collision handling

Incoming native shares are converted into the same durable browser draft model used by the destination UI. The model stores text plus enough file data in IndexedDB to survive WebView navigation or reload; localStorage remains suitable only for small scalar draft fields.

If the destination draft is empty, the incoming share populates it immediately. If the user already has non-empty text or attachments, the existing draft is preserved and the incoming share is stored as a separate pending draft. The UI presents a concise notice allowing the user to open the incoming draft rather than merging into or overwriting current work.

React acknowledges the native inbox entry only after the corresponding browser draft has been committed to IndexedDB. This gives the handoff at-least-once delivery without data loss. Manifest IDs make repeated imports idempotent.

Cancelled browser drafts delete their IndexedDB file blobs. Native inbox entries older than seven days are pruned when `list()` runs, covering abandoned extensions and failed handoffs.

### Opening the destination UI

The Share Extension uses these app deep links:

- `orchestrel://share/<share-id>`
- `orcchat://share/<share-id>`

The native app intercepts these URLs; they are not navigated as web URLs. It notifies the plugin and directs the WebView to the existing destination:

- Orchestrel: board route with the standard new-card panel open;
- Orc Chat: `/chat/19` with the standard new-chat composer open.

The share manifest ID is not exposed to the hosted web server in a query string. The React bridge consumes the pending native inbox directly.

The apps' long-lived Apache form authentication remains unchanged. The extension never needs the web session cookie because it performs no network request.

## Submission Data Flow

### New chat

1. User shares content to Orc Chat.
2. Extension writes the App Group inbox entry and opens `orcchat://share/<id>`.
3. The app opens `/chat/19`; React imports the text and files into the new-chat draft.
4. User edits commentary and presses **Start chat**.
5. React uploads files through `/api/upload` and receives `FileRef[]`.
6. React creates the running card without relying on column-change auto-start for the initial attachment prompt.
7. React sends/starts the initial agent prompt with the uploaded `FileRef[]`, using `buildPromptWithFiles` so the agent receives readable local paths.
8. The card/session route opens.

### New card

For a card saved outside `running`, attachment metadata must remain available until the card is eventually started. Add a durable pending-initial-attachments field to the card model, represented as validated JSON `FileRef[]`. The uploaded files therefore need durable server storage rather than the current `/tmp` location when attached to an unstarted card.

On save:

1. React uploads draft files as card-draft uploads.
2. The server stores them under an application-managed attachment directory and returns `FileRef[]`.
3. Card creation persists those references as pending initial attachments.
4. When an event independently implies that an unstarted card in `running` should start, `startCardSession` builds the first prompt from the card description plus pending attachment references.
5. After the session accepts the start request, the server clears the pending field; files remain long enough for the node-side agent to read them.

For a new card saved directly to `running`, the same persisted pending attachment path is used. This keeps card creation and session startup event-driven and avoids a special ordered client workflow.

The attachment storage design must account for multi-node execution: an orcd node must be able to read attachment paths supplied in a prompt. Add an authenticated orcd file-staging command. Before session creation, the backend streams each persisted attachment to the card's OrcdClient; orcd writes it under its node-local staging root and returns the node-local `FileRef` path used by `buildPromptWithFiles`. Local-node cards use this same command rather than a separate filesystem shortcut.

A backend-local path is never sent to an orcd node. Staging is keyed by card ID and attachment ID and is idempotent, so replayed start events reuse the same node-local file rather than duplicating it.

## File Lifecycle

There are three distinct storage phases:

1. **Native inbox:** private App Group copy before the WebView imports the share.
2. **Browser draft:** IndexedDB blob while the user edits and may cancel.
3. **Server/node staged attachment:** created only on explicit save/start and retained through initial prompt creation.

Cleanup rules:

- Native files are removed after browser persistence acknowledgement or explicit discard.
- Browser blobs are removed after successful submission or explicit draft cancellation.
- Failed submission retains browser blobs for retry.
- Server staging removes abandoned unattached uploads after a defined expiry.
- Initial attachment files are removed after the session has safely ingested the prompt, subject to agent tool-read timing; cleanup must not race the agent's `Read` call.

## Error Handling

- One bad share item does not reject the entire share.
- Extension errors are included in the manifest and shown inline in the destination draft.
- A missing App Group or malformed manifest produces a visible import error and leaves the inbox entry available for diagnosis/retry.
- Oversized files are rejected before browser conversion and again by the upload endpoint.
- Failed uploads do not create a card or chat and leave the draft intact.
- If card creation succeeds but session startup fails, the existing card/session failure behavior applies and persisted attachment references remain available for retry.
- Duplicate deep links and cold-launch polling are safe because imports and staging use stable IDs.

## Security

- Share manifests and files stay in app-private App Group containers.
- Filenames are sanitized before native and server filesystem writes.
- All manifests are schema-validated on both sides of the bridge.
- File size is checked from provider metadata and actual copied bytes.
- Native file URLs are accepted only when they resolve inside the expected App Group inbox.
- Server and orcd attachment paths are accepted only inside configured staging roots.
- No Apache cookie, credential, or auth token is shared with the extension.

## Testing and Verification

### Native

- Build both containing apps and both Share Extension targets with `xcodebuild`.
- Verify extension activation for URL, text, image, and generic file providers.
- Verify atomic manifests, filename sanitization, file-size rejection, and mixed valid/invalid shares.
- Verify cold launch and already-running deep-link delivery.
- Verify each extension can access only its own App Group.

### Web

Unit tests are justified for the draft importer and attachment state because they catch realistic data-loss bugs: duplicate delivery, overwrite of an existing draft, partial conversion failure, and acknowledgement before durable persistence. Unit tests are also appropriate for initial attachment prompt construction and staging path validation because these are deterministic security and lifecycle boundaries.

Component/integration verification covers:

- URL populates the new-card/new-chat textarea;
- files display with the same chips as session attachments;
- commentary remains editable;
- existing drafts are preserved on incoming share;
- cancellation creates no card and performs no upload;
- upload failure retains the draft;
- successful new chat sends files in its initial prompt;
- a backlog card retains attachments and sends them when later moved to running;
- remote-node cards receive node-local staged paths.

### Manual acceptance

On a physical iOS device, share each of the following from Safari, Photos, Files, and Notes into both apps:

- one URL;
- selected text plus a URL;
- one image;
- one PDF;
- multiple mixed items;
- a file over 25 MB;
- a share while an existing draft has unsaved commentary.

In every successful case, the standard destination UI opens, content is prefilled, commentary can be added, and nothing is created until explicit submission.

## Out of Scope

- Android share intents.
- Public web share targets.
- Rich URL preview cards or metadata scraping.
- Editing projects from the Share Extension.
- Background creation without opening a draft.
- A permanent card-level attachment library separate from the initial conversation prompt.
