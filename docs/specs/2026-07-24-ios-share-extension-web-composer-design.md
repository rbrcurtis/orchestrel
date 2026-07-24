# iOS Share Extension Web Composer Design

## Goal

Let users share text, URLs, images, and files into Orchestrel or Orc Chat and finish creating the card/chat entirely inside the iOS Share Extension.

- Orchestrel shows a project picker and creates a standard card.
- Orc Chat is fixed to project `19` and starts a chat.
- Users can add commentary before submitting.
- Files use the same attachment-chip interaction as the main web UI.
- The extension returns to the source app after success; it does not attempt to launch the containing app.

## Why This Replaces the Previous Handoff Design

Apple does not reliably permit Share Extensions to open their containing apps. On the target iOS 26 device, both `NSExtensionContext.open` and responder-chain `openURL:` handoffs failed. Capacitor share-target plugins persist data for later app consumption; they do not provide a supported immediate app-launch mechanism.

To preserve a one-step workflow, the composer lives inside the Share Extension. This design supersedes the app-launch and native-to-main-WebView portions of `2026-07-24-ios-share-to-design.md`. Existing durable initial-attachment and orcd staging work remains applicable.

## User Experience

### Orchestrel

The share sheet opens `https://orchestrel.com/share/card` in a compact web composer containing:

- shared URL/text in an editable commentary textarea;
- shared files as removable attachment chips;
- an active-project picker;
- a card title;
- a status picker defaulting to Backlog;
- **Create Card** and Cancel actions.

Successful creation briefly confirms success and dismisses the extension back to the source app.

### Orc Chat

The share sheet opens `https://orchestrel.com/share/chat/19` with:

- shared URL/text in the prompt textarea;
- shared files as removable attachment chips;
- no project picker;
- **Start Chat** and Cancel actions.

Submission creates a project `19` card in Running with `archiveOthers: true`, then dismisses the extension.

### Authentication

The extension loads the Apache-protected website in a persistent `WKWebView`.

- On first use, Apache's normal login page appears.
- `WKWebsiteDataStore.default()` retains the extension's cookie store across invocations.
- Apache's one-year session makes login a one-time setup in normal operation.
- No API token, password, or cookie is embedded.
- The extension establishes its own browser session rather than sharing the containing app's WebView cookies.

If authentication expires, the normal login flow appears again and returns to the requested share route.

## Native Extension Architecture

| Extension | App Group | Composer URL |
| --- | --- | --- |
| `com.orchestrel.ios.share` | `group.com.orchestrel.ios.share` | `https://orchestrel.com/share/card` |
| `com.orchestrel.orcchat.ios.share` | `group.com.orchestrel.orcchat.ios.share` | `https://orchestrel.com/share/chat/19` |

Each `ShareViewController`:

1. Normalizes provider items into text, URLs, and files.
2. Copies files into an atomic App Group inbox entry, enforcing the 25 MB per-file limit.
3. Creates a `WKWebView` using the default persistent data store.
4. Registers a script-message bridge named `orchestrelShare`.
5. Loads the composer URL.
6. Waits for `{ type: "ready" }` from the page.
7. Delivers manifest metadata through the bridge.
8. Serves file bytes in bounded chunks on request.
9. On `{ type: "complete" }`, deletes the inbox entry and calls `completeRequest`.
10. On `{ type: "cancel" }`, deletes the inbox entry and cancels the request.

The extension no longer launches the containing app. The containing app's custom share plugin, custom bridge controller, deep-link interception, and React inbox polling are removed.

## Native/Web Bridge

Web-to-native messages:

```ts
type ShareBridgeRequest =
  | { type: 'ready' }
  | { type: 'readChunk'; requestId: string; fileId: string; offset: number; length: number }
  | { type: 'complete' }
  | { type: 'cancel' };
```

Native-to-web messages:

```ts
type ShareBridgeResponse =
  | {
      type: 'manifest';
      manifest: {
        version: 1;
        id: string;
        text: string;
        files: Array<{ id: string; name: string; mimeType: string; size: number }>;
        errors: string[];
      };
    }
  | { type: 'chunk'; requestId: string; fileId: string; offset: number; base64: string; done: boolean }
  | { type: 'error'; requestId?: string; message: string };
```

All IDs and paths are validated against the current inbox entry. The page cannot request arbitrary App Group paths.

### File transfer

The page requests one file at a time in 512 KB chunks, decodes chunks into `Uint8Array`s, then constructs a browser `File`. Files import sequentially to bound extension memory. Individual failures appear inline without discarding valid content.

### Navigation safety

The bridge is available only to the main frame on allowed Orchestrel/authentication origins. Native ignores untrusted-frame and untrusted-origin messages.

## Web Composer

Add focused React routes without board/chat navigation:

- `share/card`
- `share/chat/:projectId`

A shared composer owns native bridge initialization, commentary/files, upload progress, project/title/status fields where applicable, and explicit submit/cancel behavior. It reuses the existing attachment-chip UI and backend card-creation rules.

When opened outside the native bridge, routes show: “Open this page from the iOS share sheet.”

### Submission

The page uses normal authenticated REST calls:

1. `GET /api/projects` for active projects.
2. `POST /api/upload` with a stable draft ID.
3. `POST /api/cards` with durable `pendingInitialFiles`.

Extend card creation as needed to accept `column`, `archiveOthers`, and `pendingInitialFiles`. Orc Chat creates project `19` in Running with `archiveOthers: true`; the independent running-card listener stages attachments and starts the initial prompt.

No card is created if upload fails. The extension remains open for retry.

## Data Lifecycle

1. Shared content is copied into the App Group before the composer loads.
2. The page imports native files into browser `File` objects.
3. Submission uploads files to durable backend storage.
4. Card creation persists `pendingInitialFiles`.
5. Session startup stages files to the card's orcd node.
6. App Group files are deleted only after successful card creation and `{ type: "complete" }`.
7. Cancel deletes the current inbox entry and creates no server card.
8. Failed submission retains native files for retry or cancel.
9. Entries older than seven days are pruned on extension startup.

## Error Handling and Security

- Login/network failures remain visible for retry or cancel.
- Unsupported and oversized items are listed while valid items remain.
- Malformed bridge messages are ignored and logged.
- Reads reject invalid IDs, offsets, lengths, and paths.
- Duplicate submit taps are disabled while submitting.
- Completion is idempotent.
- Native, browser, server, and orcd boundaries enforce 25 MB per file.
- REST endpoints continue to require normal Apache authentication; no bypass is added.

## Verification

### Native

- Build both containing apps and Share Extensions for simulator and signed device.
- Verify first-use Apache login persists.
- Verify URL, text, image, PDF, mixed items, and oversized files.
- Verify chunk boundaries, invalid IDs, cancellation, and cleanup.
- Verify success dismisses to the source app without launching the containing app.

### Web/backend

- Verify manifest text and files populate the composer.
- Verify archived projects are excluded.
- Verify uploads complete before card creation.
- Verify failed uploads do not create cards.
- Verify card and project `19` chat creation behavior.
- Run unit tests, lint, typecheck, production build, and both signed iOS builds.
