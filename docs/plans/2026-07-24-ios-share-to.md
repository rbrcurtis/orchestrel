# iOS Share-to-Orchestrel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add iOS Share Extensions to Orchestrel and Orc Chat so shared text, URLs, images, and files open the existing new-card/new-chat drafts, with files following the existing attachment UX and initial-prompt path.

**Architecture:** Each Share Extension writes an atomic manifest and copied files into its private App Group, then opens its containing app with a custom URL scheme. A local Capacitor plugin imports the manifest into an IndexedDB-backed React draft. On explicit submission, the backend stores draft uploads durably, persists attachment refs on the card, stages bytes to the card's orcd node, and includes node-local paths in the initial prompt.

**Tech Stack:** Swift 5.9, iOS Share Extensions, Capacitor 8.4, React 19, TypeScript, IndexedDB via `idb-keyval`, Express/Multer, TypeORM/SQLite, authenticated orcd TCP protocol, Vitest, Xcodebuild.

## Global Constraints

- Support plain text, URLs, images, and arbitrary files, including mixed multi-item shares.
- Keep the existing 25 MB per-file limit at native import, browser attachment, and server upload boundaries.
- Shared content must never create a card, start a chat, or upload a file before explicit submission.
- Orchestrel opens the standard new-card UI; Orc Chat opens the standard new-chat UI for project `1`.
- Preserve an existing non-empty draft; store an incoming share as a separate pending draft rather than merging or overwriting it.
- Acknowledge native inbox entries only after the browser draft is durable in IndexedDB.
- Keep handlers event-driven: card creation persists attachment refs; the independent running-card session listener observes current card state and stages attachments.
- Never send a backend-local attachment path to a remote orcd node.
- Use `group.com.orchestrel.ios.share` / `orchestrel://share/<id>` for Orchestrel and `group.com.orchestrel.orcchat.ios.share` / `orcchat://share/<id>` for Orc Chat.
- Preserve Apache form authentication unchanged; Share Extensions perform no network requests.
- Public App Store distribution is out of scope; the responder-chain app-opening handoff is acceptable for current private distribution.
- Do not add Android share intents, rich URL previews, extension-side project selection, background card creation, or a permanent card attachment library.

## File Map

### Shared web attachment and draft units

- Create `app/lib/file-attachments.ts` — 25 MB validation, deduplication, and `/api/upload` client.
- Create `app/components/FileAttachments.tsx` — attachment chips, picker, image paste, and drop behavior shared by all three composers.
- Create `app/lib/shared-drafts.ts` — native plugin contract, schema validation, native-file conversion, IndexedDB persistence, collision-safe queueing, acknowledgement.
- Create `app/lib/shared-drafts.test.ts` — high-value state/import tests.
- Create `app/components/SharedDraftNotice.tsx` — concise pending-draft/open/discard affordance.
- Modify `app/components/SessionView.tsx` — consume shared attachment units.
- Modify `app/components/CardDetail.tsx` — persist new-card text/files and submit durable attachment refs.
- Modify `app/routes/board.tsx` — receive native share signal and open the standard backlog new-card panel.
- Modify `app/routes/chat.$projectId.tsx` — receive the Orc Chat draft, render attachments, and submit refs with the running card.
- Modify `app/stores/card-store.ts` and tests — pass pending initial attachments in card creation.
- Modify `src/shared/ws-protocol.ts` — add validated pending attachment fields.

### Durable backend and node staging

- Create `src/server/attachments.ts` — durable draft upload storage, path validation, read/delete/prune operations, and upload router.
- Create `src/server/attachments.test.ts` — path/security/lifecycle tests.
- Modify `src/server/init.ts` and `src/server/ws/server.ts` — mount the shared upload router rather than duplicate `/api/upload` implementations.
- Modify `src/server/models/Card.ts`, `src/server/models/index.ts`, and `src/server/services/card.ts` — persist `pending_initial_files` JSON.
- Modify `src/shared/orcd-protocol.ts` — define `file_stage` action/result.
- Create `src/orcd/file-staging.ts` and `src/orcd/__tests__/file-staging.test.ts` — node-local idempotent staging and pruning.
- Modify `src/orcd/socket-server.ts` — handle authenticated staging requests.
- Modify `src/server/orcd-client.ts` — expose `stageFile()`.
- Modify `src/server/sessions/manager.ts` and tests — validate node-local staged paths and build the initial prompt.
- Modify `src/server/controllers/card-sessions.ts` and tests — stage pending files before initial create, clear refs only after acceptance.

### Native apps

For each of `mobile/orchestrel` and `mobile/orc-chat`:

- Create `ios/App/App/SharedDraftPlugin.swift` — Capacitor bridge over the App Group inbox.
- Create `ios/App/App/App.entitlements` — containing-app App Group entitlement.
- Create `ios/ShareExtension/ShareViewController.swift` — provider normalization, atomic inbox write, and app handoff.
- Create `ios/ShareExtension/Info.plist` — activation rules for URL/text/image/file.
- Create `ios/ShareExtension/ShareExtension.entitlements` — extension App Group entitlement.
- Modify `ios/App/App/AppDelegate.swift` — intercept app-specific share URLs and navigate the WebView destination.
- Modify `ios/App/App.xcodeproj/project.pbxproj` — add extension target, embedding phase, entitlements, plugin source, and URL scheme.
- Modify `package.json` / `package-lock.json` only if Capacitor sync changes them; do not hand-edit generated `ios/App/App/public` or generated Capacitor config files.

---

### Task 1: Reusable Browser Attachment State and Upload Client

**Files:**
- Create: `app/lib/file-attachments.ts`
- Create: `app/components/FileAttachments.tsx`
- Modify: `app/components/SessionView.tsx:386-674`
- Test: `app/lib/file-attachments.test.ts`

**Interfaces:**
- Produces: `MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024`
- Produces: `addAttachmentFiles(current: File[], incoming: File[]): { files: File[]; errors: string[] }`
- Produces: `uploadFiles(files: File[], opts?: { draftId?: string; sessionId?: string }): Promise<FileRef[]>`
- Produces: `<FileAttachments files errors disabled onFilesChange onErrorsChange children />`, where `children` is the textarea/control region receiving paste/drop support.

**Why these tests are worth keeping:** Deduplication and exact size-boundary handling are user-visible decision logic shared by three submission paths. Unit level is the cheapest truthful level and does not duplicate browser framework behavior.

- [ ] **Step 1: Write failing file-state tests**

Create `app/lib/file-attachments.test.ts` with cases that assert:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES, addAttachmentFiles } from './file-attachments';

describe('addAttachmentFiles', () => {
  it('keeps valid files, rejects files over 25 MB, and reports their names', () => {
    const valid = new File(['ok'], 'notes.txt', { type: 'text/plain' });
    const oversized = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'movie.mov');
    const result = addAttachmentFiles([], [valid, oversized]);
    expect(result.files.map((f) => f.name)).toEqual(['notes.txt']);
    expect(result.errors).toEqual(['movie.mov exceeds the 25 MB limit']);
  });

  it('deduplicates the same name, size, type, and lastModified', () => {
    const a = new File(['same'], 'photo.png', { type: 'image/png', lastModified: 10 });
    const b = new File(['same'], 'photo.png', { type: 'image/png', lastModified: 10 });
    expect(addAttachmentFiles([a], [b]).files).toEqual([a]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `bunx vitest run app/lib/file-attachments.test.ts`

Expected: FAIL because `file-attachments.ts` does not exist.

- [ ] **Step 3: Implement file validation and upload**

Create `app/lib/file-attachments.ts`. Use a stable key of `name\0size\0type\0lastModified`; accept files at exactly 25 MB; append `draftId` or `sessionId` to `FormData`; parse the response through `z.object({ files: z.array(fileRefSchema) })`; throw the server error body when available.

Core signatures:

```ts
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function addAttachmentFiles(current: File[], incoming: File[]) {
  const files = [...current];
  const errors: string[] = [];
  const seen = new Set(current.map(fileKey));
  for (const file of incoming) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`${file.name} exceeds the 25 MB limit`);
      continue;
    }
    const key = fileKey(file);
    if (!seen.has(key)) {
      files.push(file);
      seen.add(key);
    }
  }
  return { files, errors };
}

export async function uploadFiles(
  files: File[],
  opts: { draftId?: string; sessionId?: string } = {},
): Promise<FileRef[]> { /* FormData + validated fetch */ }
```

- [ ] **Step 4: Extract the attachment UI**

Create `app/components/FileAttachments.tsx`. Move attachment chips, hidden multiple file input, paperclip, image-only clipboard extraction, drop ring, and error rendering out of `PromptInput`. The component must call `addAttachmentFiles`, must not own submission, and must allow a `File[]` supplied by native draft import.

Use this public shape:

```ts
type Props = {
  files: File[];
  errors: string[];
  disabled?: boolean;
  onFilesChange: (files: File[]) => void;
  onErrorsChange: (errors: string[]) => void;
  children: (props: {
    onPaste: (e: React.ClipboardEvent) => void;
    openPicker: () => void;
    dragging: boolean;
  }) => React.ReactNode;
};
```

- [ ] **Step 5: Replace SessionView's private attachment implementation**

In `PromptInput`, retain `files` and `uploadError` state, replace local `addFiles`, paste/drop, chip, and input code with `FileAttachments`, and call the new `uploadFiles(files, { sessionId: undefined })`. Preserve existing send, focus, stop, reconnect, and keyboard behavior exactly.

- [ ] **Step 6: Verify GREEN and existing composer behavior**

Run:

```bash
bunx vitest run app/lib/file-attachments.test.ts app/components/SessionView.test.tsx
bun run typecheck
```

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 7: Commit**

```bash
git add app/lib/file-attachments.ts app/lib/file-attachments.test.ts app/components/FileAttachments.tsx app/components/SessionView.tsx
git commit -m "refactor: share attachment composer behavior"
```

---

### Task 2: Durable Card Uploads and Pending Initial Attachment Schema

**Files:**
- Create: `src/server/attachments.ts`
- Create: `src/server/attachments.test.ts`
- Modify: `src/server/init.ts:33-65`
- Modify: `src/server/ws/server.ts:52-91`
- Modify: `src/server/models/Card.ts`
- Modify: `src/server/models/index.ts:40-110`
- Modify: `src/server/services/card.ts`
- Modify: `src/shared/ws-protocol.ts`
- Modify: `app/stores/card-store.ts`
- Modify: `app/stores/card-store.test.ts`

**Interfaces:**
- Consumes: `FileRef`, `MAX_ATTACHMENT_BYTES` semantics from Task 1.
- Produces: `createAttachmentRouter(): express.Router`
- Produces: `readAttachment(ref: FileRef): Buffer`, `deleteAttachments(refs: FileRef[]): void`, `pruneAttachments(now?: number): void`
- Produces: `Card.pendingInitialFiles: FileRef[]`
- Produces: `cardCreateSchema.pendingInitialFiles?: FileRef[]`

**Why these tests are worth keeping:** Filesystem root validation and persistence are security/data-lifecycle boundaries where traversal or lost refs have real impact. Route-level upload checks are more truthful than mocked unit wiring; card-store coverage verifies meaningful payload preservation without retesting WebSocket plumbing broadly.

- [ ] **Step 1: Write failing attachment storage tests**

Create `src/server/attachments.test.ts` using a temporary root injected through a factory. Cover:

```ts
it('stores a sanitized durable draft upload and reads it only inside the root', async () => {
  const store = createAttachmentStore(tempDir);
  const ref = store.write('draft-1', '../../invoice.pdf', 'application/pdf', Buffer.from('pdf'));
  expect(ref.name).toBe('invoice.pdf');
  expect(store.read(ref).toString()).toBe('pdf');
  expect(() => store.read({ ...ref, path: '/etc/passwd' })).toThrow('outside attachment root');
});

it('reuses stable draft and file ids without escaping the root', () => { /* assert normalized path */ });
it('prunes only unreferenced directories older than seven days', () => { /* controlled mtimes */ });
```

- [ ] **Step 2: Run the storage tests and confirm RED**

Run: `bunx vitest run src/server/attachments.test.ts`

Expected: FAIL because `attachments.ts` does not exist.

- [ ] **Step 3: Implement durable attachment storage and router**

Create `src/server/attachments.ts` with root `data/attachments`, IDs restricted to `[A-Za-z0-9_-]`, `basename()` filenames, UUID file prefixes, and `resolve(candidate).startsWith(resolve(root) + sep)` validation. The router accepts `files`, requires a sanitized `draftId` for durable draft submissions, preserves legacy `sessionId` uploads under `/tmp/orchestrel-uploads`, and returns validated `FileRef[]`.

Do not buffer beyond Multer's 25 MB per-file limit. Return HTTP 400 for missing files/IDs and HTTP 413 for size errors.

- [ ] **Step 4: Mount one shared upload router in both server entry paths**

Replace duplicated Multer blocks in `src/server/init.ts` and `src/server/ws/server.ts` with dynamically imported `createAttachmentRouter()` and `router.use(createAttachmentRouter())`. Keep dynamic import in the Vite path so restart-surviving state rules are not disturbed.

- [ ] **Step 5: Add the card field and DB migration**

Add to `Card`:

```ts
@Column({ name: 'pending_initial_files', type: 'simple-json', nullable: false, default: '[]' })
pendingInitialFiles!: FileRef[];
```

Add an idempotent migration in `initDatabase()`:

```sql
ALTER TABLE cards ADD COLUMN pending_initial_files TEXT NOT NULL DEFAULT '[]'
```

Then normalize existing null values to `'[]'`. Do not run WAL or journal pragmas.

- [ ] **Step 6: Extend shared schemas and mutation payloads**

Add `pendingInitialFiles: z.array(fileRefSchema).default([])` to `cardSchema`, and optional `pendingInitialFiles: z.array(fileRefSchema)` to `cardCreateSchema`. Ensure `cardUpdateSchema` does **not** expose arbitrary browser updates to this field; backend lifecycle code owns clearing it.

Update `CardStore.createCard` and `createChatCard` argument types and `card:create` payloads to pass `pendingInitialFiles`.

- [ ] **Step 7: Add focused card-store assertions**

Extend `app/stores/card-store.test.ts` with one card and one chat case asserting that supplied refs are included in `card:create`; do not add tests for omitted/default fields already enforced by TypeScript/schema defaults.

- [ ] **Step 8: Verify persistence and payloads**

Run:

```bash
bunx vitest run src/server/attachments.test.ts app/stores/card-store.test.ts src/server/services/card.test.ts
bun run typecheck
```

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/server/attachments.ts src/server/attachments.test.ts src/server/init.ts src/server/ws/server.ts src/server/models/Card.ts src/server/models/index.ts src/server/services/card.ts src/shared/ws-protocol.ts app/stores/card-store.ts app/stores/card-store.test.ts
git commit -m "feat: persist initial card attachments"
```

---

### Task 3: Authenticated orcd File Staging

**Files:**
- Modify: `src/shared/orcd-protocol.ts`
- Create: `src/orcd/file-staging.ts`
- Create: `src/orcd/__tests__/file-staging.test.ts`
- Modify: `src/orcd/socket-server.ts`
- Modify: `src/orcd/__tests__/socket-server-auth.test.ts`
- Modify: `src/server/orcd-client.ts`

**Interfaces:**
- Produces: `FileStageAction { action: 'file_stage'; cardId; file: { id; name; mimeType; size; base64 }; requestId? }`
- Produces: `FileStagedMessage { type: 'file_staged'; requestId?; file: FileRef }`
- Produces: `stageFile(input: { cardId: number; file: Omit<FileRef, 'path'>; bytes: Buffer }): Promise<FileRef>`
- Produces: node-local files under `/tmp/orchestrel-attachments/<cardId>/<id>-<sanitized-name>`.

**Why these tests are worth keeping:** Staging is authenticated remote input, path construction, idempotence, and byte-integrity logic. These are high-impact branches best tested locally; existing socket auth tests are the truthful level for pre-auth rejection.

- [ ] **Step 1: Write failing node staging tests**

Create `src/orcd/__tests__/file-staging.test.ts` with an injected temporary root:

```ts
it('writes decoded bytes under the card root and returns a node-local FileRef', () => {
  const staged = stageFile(root, {
    cardId: 42,
    file: { id: 'abc', name: '../photo.png', mimeType: 'image/png', size: 3, base64: Buffer.from('img').toString('base64') },
  });
  expect(staged.name).toBe('photo.png');
  expect(readFileSync(staged.path, 'utf8')).toBe('img');
});

it('is idempotent for the same card and attachment id', () => { /* stage twice, same path/content */ });
it('rejects invalid ids and decoded size mismatches', () => { /* both branches */ });
it('prunes staging directories older than seven days', () => { /* controlled mtime */ });
```

- [ ] **Step 2: Run and confirm RED**

Run: `bunx vitest run src/orcd/__tests__/file-staging.test.ts`

Expected: FAIL because `file-staging.ts` does not exist.

- [ ] **Step 3: Implement staging and protocol types**

Add protocol action/result unions and implement `src/orcd/file-staging.ts`. Validate card ID, attachment ID, basename, declared size, and max size. Write to a temporary sibling then rename atomically. If the final path exists with matching bytes/size, return it unchanged.

- [ ] **Step 4: Wire authenticated socket handling**

Add `file_stage` to the post-hello switch in `OrcdServer`. Decode/stage in a `try/catch`, return `file_staged` with the same `requestId`, and return a request-correlated error on failure. Do not accept staging before `hello`.

Add one socket integration assertion that an unauthenticated `file_stage` creates no file and produces no success response; rely on the staging unit tests for transformation details.

- [ ] **Step 5: Add OrcdClient.stageFile**

Implement:

```ts
async stageFile(opts: {
  cardId: number;
  file: Pick<FileRef, 'id' | 'name' | 'mimeType' | 'size'>;
  bytes: Buffer;
}): Promise<FileRef> {
  const msg = await this.request({
    action: 'file_stage',
    cardId: opts.cardId,
    file: { ...opts.file, base64: opts.bytes.toString('base64') },
  });
  if (msg.type !== 'file_staged') throw new Error('unexpected file staging response');
  return msg.file;
}
```

Update request dispatch so `file_staged` resolves its request ID exactly like other request/response messages.

- [ ] **Step 6: Verify staging**

Run:

```bash
bunx vitest run src/orcd/__tests__/file-staging.test.ts src/orcd/__tests__/socket-server-auth.test.ts src/orcd/__tests__/socket-server-tcp.test.ts
bun run typecheck
```

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/shared/orcd-protocol.ts src/orcd/file-staging.ts src/orcd/__tests__/file-staging.test.ts src/orcd/socket-server.ts src/orcd/__tests__/socket-server-auth.test.ts src/server/orcd-client.ts
git commit -m "feat: stage attachments on orcd nodes"
```

---

### Task 4: Initial Prompt Attachment Lifecycle

**Files:**
- Modify: `src/server/sessions/manager.ts`
- Create: `src/server/sessions/manager.test.ts` if no focused test exists
- Modify: `src/server/controllers/card-sessions.ts:665-720`
- Modify: `src/server/controllers/card-sessions.test.ts`
- Modify: `src/server/attachments.ts`

**Interfaces:**
- Consumes: `readAttachment(ref)`, `deleteAttachments(refs)`, `OrcdClient.stageFile()` from Tasks 2–3.
- Produces: `stageCardAttachments(client, card): Promise<FileRef[]>`
- Produces: initial session prompt built with `buildPromptWithFiles(card.description || card.title, stagedFiles)`.

**Why these tests are worth keeping:** The bug risks are realistic and severe: starting before staging, sending backend paths remotely, clearing refs on failed start, or double-staging on replay. Controller-level tests are appropriate because the behavior is an event-driven lifecycle boundary, not UI plumbing.

- [ ] **Step 1: Write failing lifecycle tests**

Extend `src/server/controllers/card-sessions.test.ts` with tests that observe public effects:

1. A running card with pending refs calls `stageFile` with backend bytes, then `create` receives only returned node-local paths.
2. Pending refs clear after `create` accepts the session and the card is saved.
3. A staging or create rejection leaves pending refs intact and moves the card through existing start-failure behavior.
4. Replayed startup stages by stable card/file IDs and does not create a second backend reference.
5. A card with no files retains the existing prompt exactly.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `bunx vitest run src/server/controllers/card-sessions.test.ts`

Expected: new attachment assertions fail because startup ignores `pendingInitialFiles`.

- [ ] **Step 3: Tighten prompt path validation**

Change `buildPromptWithFiles` to accept an explicit allowed root or to validate only node-local `/tmp/orchestrel-attachments/` paths for staged initial files plus legacy `/tmp/orchestrel-uploads/` paths for live messages. Use `resolve(path).startsWith(resolve(root) + sep)`, not a bare string prefix.

Add focused tests for valid staged paths and traversal/prefix-confusion paths such as `/tmp/orchestrel-attachments-evil/file`.

- [ ] **Step 4: Stage files in startCardSession**

Before `client.create()` for a card without `sessionId`:

```ts
const pending = card.pendingInitialFiles ?? [];
const staged: FileRef[] = [];
for (const file of pending) {
  staged.push(await client.stageFile({
    cardId: card.id,
    file,
    bytes: readAttachment(file),
  }));
}
const rawPrompt = card.description || card.title;
const prompt = buildPromptWithFiles(rawPrompt, staged);
```

For resumed sessions keep the current empty prompt and do not resend initial files.

After `client.create()` returns, set `pendingInitialFiles = []`, save the card, and then delete backend attachment copies. If staging/create fails, do not clear or delete them.

- [ ] **Step 5: Verify lifecycle behavior**

Run:

```bash
bunx vitest run src/server/sessions/manager.test.ts src/server/controllers/card-sessions.test.ts src/server/ws/handlers/agents.test.ts
bun run typecheck
```

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/sessions/manager.ts src/server/sessions/manager.test.ts src/server/controllers/card-sessions.ts src/server/controllers/card-sessions.test.ts src/server/attachments.ts
git commit -m "feat: send card attachments in initial prompts"
```

---

### Task 5: IndexedDB Shared-Draft Import and Collision Queue

**Files:**
- Create: `app/lib/shared-drafts.ts`
- Create: `app/lib/shared-drafts.test.ts`
- Create: `app/components/SharedDraftNotice.tsx`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces: `SharedDraft { id; destination: 'card' | 'chat'; text; files: File[]; errors; createdAt }`
- Produces: `importNativeSharedDrafts(destination): Promise<SharedDraft[]>`
- Produces: `getActiveDraft(destination): Promise<SharedDraft | null>`
- Produces: `saveActiveDraft`, `queueDraft`, `activateQueuedDraft`, `discardDraft`
- Produces: `subscribeToNativeShares(callback): Promise<() => void>`
- Uses Capacitor plugin `SharedDraft` only when `Capacitor.isNativePlatform()`; browser builds remain no-op.

**Why these tests are worth keeping:** At-least-once import, acknowledgement ordering, and collision preservation directly prevent shared-content data loss. These branchy persistence rules are deterministic and cheapest to test with an in-memory `idb-keyval` store adapter and fake plugin.

- [ ] **Step 1: Add the browser Capacitor dependency**

Run: `bun add @capacitor/core@8.4.0`

Expected: root `package.json` and `bun.lock` add exactly the core runtime used to call `registerPlugin`; do not add iOS/CLI packages back to the root.

- [ ] **Step 2: Write failing import and collision tests**

Create `app/lib/shared-drafts.test.ts` around injected `DraftStorage` and `SharedDraftNative` interfaces. Cover:

```ts
it('acknowledges native content only after files and manifest are persisted', async () => {
  const order: string[] = [];
  // fake storage pushes "persist"; fake plugin acknowledge pushes "ack"
  await importNativeSharedDrafts('card', deps);
  expect(order).toEqual(['persist', 'ack']);
});

it('does not acknowledge when file conversion or persistence fails', async () => { /* ack absent */ });
it('imports duplicate manifest ids only once', async () => { /* one durable record */ });
it('fills an empty active draft but queues incoming content behind a non-empty draft', async () => { /* preserve old */ });
it('keeps valid files and records one failed native-file conversion inline', async () => { /* partial success */ });
it('prunes acknowledged browser drafts only after submission or explicit discard', async () => { /* retry retention */ });
```

- [ ] **Step 3: Run and confirm RED**

Run: `bunx vitest run app/lib/shared-drafts.test.ts`

Expected: FAIL because `shared-drafts.ts` does not exist.

- [ ] **Step 4: Implement schema, native bridge, and IndexedDB storage**

Use `registerPlugin<SharedDraftPlugin>('SharedDraft')`, Zod schemas for all plugin results, `Capacitor.convertFileSrc(url)` plus `fetch(...).blob()` to construct `File`, and `idb-keyval` keys namespaced by destination and manifest ID.

Expose dependency-injected internals for tests without exporting private helpers solely for testing. Production entry points use the real plugin/store defaults.

Treat a draft as empty only when trimmed text is empty and files are empty. Persist `Blob`/`File` values directly in IndexedDB. Keep native `errors` with the browser draft.

- [ ] **Step 5: Implement pending-draft notice**

Create `SharedDraftNotice.tsx` with incoming share count, **Open shared draft**, and **Discard**. It must not auto-merge. Opening swaps the currently active empty/explicitly abandoned draft through `activateQueuedDraft`; discarding calls both browser cleanup and native discard only for entries not yet acknowledged.

- [ ] **Step 6: Verify importer behavior**

Run:

```bash
bunx vitest run app/lib/shared-drafts.test.ts
bun run typecheck
```

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock app/lib/shared-drafts.ts app/lib/shared-drafts.test.ts app/components/SharedDraftNotice.tsx
git commit -m "feat: import native shares into durable drafts"
```

---

### Task 6: Standard New-Card and New-Chat Draft Integration

**Files:**
- Modify: `app/components/CardDetail.tsx:694-905`
- Modify: `app/components/CardDetail.test.tsx`
- Modify: `app/routes/board.tsx`
- Modify: `app/routes/board.test.tsx`
- Modify: `app/routes/chat.$projectId.tsx`
- Modify: `app/routes/chat.test.tsx` or create `app/routes/chat.$projectId.test.tsx`

**Interfaces:**
- Consumes: `FileAttachments`, `uploadFiles`, and shared-draft APIs from Tasks 1 and 5.
- Consumes: `createCard/createChatCard({ pendingInitialFiles })` from Task 2.
- Produces: standard new-card/new-chat UIs that can receive native shares and ordinary picker/paste files.

**Why these tests are worth keeping:** Tests focus on the valuable workflow decisions—no upload before submit, preservation after upload failure, and correct initial attachment refs—not static copy or styling. Component level is appropriate because textarea/file state and explicit submission are the behavior.

- [ ] **Step 1: Write failing new-card workflow tests**

Extend `CardDetail.test.tsx` to assert:

- an imported draft populates description and attachment chips;
- adding commentary changes only text, not files;
- close/cancel calls draft persistence and performs no `/api/upload` or `createCard`;
- save uploads with a stable draft ID, then creates the card with returned `pendingInitialFiles`;
- failed upload leaves text/files and does not call `createCard`;
- successful creation clears IndexedDB only after card creation succeeds.

Use a real `File` and stub only network/native boundaries.

- [ ] **Step 2: Write failing new-chat workflow tests**

Create or extend the focused chat-project component test to assert the same import/edit/cancel/failure behavior and that successful submission calls:

```ts
createChatCard({
  description: 'my commentary\n\nhttps://example.com',
  projectId: 1,
  pendingInitialFiles: uploadedRefs,
});
```

A file-only chat uses description `Please review the attached files.` for title suggestion/session prompt.

- [ ] **Step 3: Run and confirm RED**

Run:

```bash
bunx vitest run app/components/CardDetail.test.tsx app/routes/chat.test.tsx app/routes/board.test.tsx
```

Expected: new assertions fail because these screens do not accept files/native drafts.

- [ ] **Step 4: Integrate NewCardDetail**

Replace description-only localStorage draft persistence with the IndexedDB shared draft model for text/files; retain scalar card settings in component state. Render `FileAttachments` around the description editor and `SharedDraftNotice` when a collision is queued.

On save, upload files first with `{ draftId: draft.id }`, then pass refs as `pendingInitialFiles`. Do not call upload when files are empty. Keep the existing title suggestion based on text. Require title and project as today; files do not bypass those requirements.

- [ ] **Step 5: Open the standard board panel on a native share**

In `BoardLayout`, subscribe once to native share events and poll pending entries on mount. If a card-destination share arrives, call existing `startNewCard('backlog')`; do not create a parallel modal or route. If the panel already contains a non-empty draft, leave it open and let `SharedDraftNotice` expose the queued share.

- [ ] **Step 6: Integrate the project-1 chat composer**

In `chat.$projectId.tsx`, hydrate the `chat` active draft, render `FileAttachments`, and persist edits. On explicit Start chat, upload first, then call `createChatCard` with refs. Navigate only after creation succeeds; retain the full draft on either upload or creation failure.

Only auto-import native Orc Chat drafts when `project.id === 1`. Browser navigation to another project continues to behave normally.

- [ ] **Step 7: Verify the workflows**

Run:

```bash
bunx vitest run app/components/CardDetail.test.tsx app/routes/chat.test.tsx app/routes/board.test.tsx app/stores/card-store.test.ts
bun run lint
bun run typecheck
```

Expected: tests, lint, and typecheck pass.

- [ ] **Step 8: Commit**

```bash
git add app/components/CardDetail.tsx app/components/CardDetail.test.tsx app/routes/board.tsx app/routes/board.test.tsx app/routes/chat.$projectId.tsx app/routes/chat.test.tsx
git commit -m "feat: open shared content in card and chat drafts"
```

---

### Task 7: Native SharedDraft Plugin for Both Apps

**Files:**
- Create: `mobile/orchestrel/ios/App/App/SharedDraftPlugin.swift`
- Create: `mobile/orchestrel/ios/App/App/App.entitlements`
- Modify: `mobile/orchestrel/ios/App/App/AppDelegate.swift`
- Modify: `mobile/orchestrel/ios/App/App/Info.plist`
- Create: `mobile/orc-chat/ios/App/App/SharedDraftPlugin.swift`
- Create: `mobile/orc-chat/ios/App/App/App.entitlements`
- Modify: `mobile/orc-chat/ios/App/App/AppDelegate.swift`
- Modify: `mobile/orc-chat/ios/App/App/Info.plist`
- Modify: both `ios/App/App.xcodeproj/project.pbxproj`

**Interfaces:**
- Consumes: App Group manifests defined in the spec.
- Produces Capacitor plugin: `list()`, `read({ id })`, `acknowledge({ id })`, `discard({ id })`, event `sharedDraftReceived`.
- Produces app deep-link routing to hosted `/` (new-card opening occurs in React) and `/chat/1`.

- [ ] **Step 1: Implement SharedDraftPlugin.swift in Orchestrel**

Implement a `CAPPlugin, CAPBridgedPlugin` named `SharedDraft` with explicit plugin methods. Validate every ID against `^[A-Fa-f0-9-]{36}$`, resolve and standardize every path under `FileManager.containerURL(forSecurityApplicationGroupIdentifier:)!/Inbox`, decode manifests with `JSONDecoder`, sort by `createdAt`, and prune directories older than seven days during `list()`.

`read` returns manifest fields and absolute `file://` URLs only after confirming standardized paths stay inside the selected entry. `acknowledge` and `discard` remove only the validated entry directory.

Expose:

```swift
@objc(SharedDraftPlugin)
public class SharedDraftPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedDraftPlugin"
    public let jsName = "SharedDraft"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discard", returnType: CAPPluginReturnPromise),
    ]
}
```

- [ ] **Step 2: Add Orchestrel app entitlement and URL handling**

Create `App.entitlements` with `com.apple.security.application-groups = [group.com.orchestrel.ios.share]`. Add `orchestrel` to `CFBundleURLTypes` in Info.plist.

In `AppDelegate.application(_:open:options:)`, intercept only `orchestrel://share/<uuid>`, load the hosted root if needed, and post `Notification.Name("SharedDraftReceived")` with the ID after the bridge exists. Return Capacitor's `ApplicationDelegateProxy` for every unrelated URL.

Have the plugin observe this notification and call `notifyListeners("sharedDraftReceived", data: ["id": id])`.

- [ ] **Step 3: Copy the plugin for Orc Chat with isolated constants**

Implement the same class under Orc Chat with App Group `group.com.orchestrel.orcchat.ios.share`, URL scheme `orcchat`, and destination `https://cecil.orchestrel.com/chat/1`. Keep its existing last-URL restoration and root redirect behavior; a share deep link takes precedence over restoration for that activation.

- [ ] **Step 4: Add plugin files and app entitlements to Xcode projects**

In both `.pbxproj` files, add `SharedDraftPlugin.swift` to the containing App target sources and set `CODE_SIGN_ENTITLEMENTS = App/App.entitlements` for Debug and Release. Ensure the plugin source is not added to the extension target later.

- [ ] **Step 5: Sync and compile containing apps**

Run:

```bash
(cd mobile/orchestrel && npm run sync)
(cd mobile/orc-chat && npm run sync)
(cd mobile/orchestrel/ios/App && xcodebuild -project App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build)
(cd mobile/orc-chat/ios/App && xcodebuild -project App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build)
```

Expected: both builds end in `** BUILD SUCCEEDED **` and generated `App/public`/Capacitor config remain ignored.

- [ ] **Step 6: Commit**

```bash
git add mobile/orchestrel/ios mobile/orc-chat/ios
git commit -m "feat: bridge shared drafts into iOS apps"
```

---

### Task 8: Native Share Extension Targets

**Files:**
- Create: `mobile/orchestrel/ios/ShareExtension/ShareViewController.swift`
- Create: `mobile/orchestrel/ios/ShareExtension/Info.plist`
- Create: `mobile/orchestrel/ios/ShareExtension/ShareExtension.entitlements`
- Create: `mobile/orc-chat/ios/ShareExtension/ShareViewController.swift`
- Create: `mobile/orc-chat/ios/ShareExtension/Info.plist`
- Create: `mobile/orc-chat/ios/ShareExtension/ShareExtension.entitlements`
- Modify: both `mobile/*/ios/App/App.xcodeproj/project.pbxproj`

**Interfaces:**
- Produces atomic `SharedDraftManifest` version 1 exactly matching Task 5/plugin schemas.
- Produces embedded `.appex` targets with bundle IDs from Global Constraints.

- [ ] **Step 1: Implement Orchestrel ShareViewController**

Use `UniformTypeIdentifiers`. Iterate extension input items/provider attachments in order. Load URL first as `URL`, plain text as `String`, image/file as an in-place file representation where available, and fall back to `Data` only when necessary.

Rules:

```swift
private let maxFileBytes: Int64 = 25 * 1024 * 1024
private let appGroup = "group.com.orchestrel.ios.share"
private let openScheme = "orchestrel"
```

Deduplicate text by exact value and files by a key of normalized source URL/name + actual byte size. Join distinct text values with `\n\n`. Copy accepted files to a temporary `Inbox/.<uuid>.tmp/files`, generate sanitized names with UUID prefixes, write `manifest.json.tmp`, rename it to `manifest.json`, then rename the whole temp entry to `Inbox/<uuid>`.

Record per-item failures in `errors`; do not discard valid items. If no valid content exists, show the collected error and let the user cancel instead of opening an empty draft.

After commit, walk the responder chain with `perform(Selector(("openURL:")), with: URL(string: "orchestrel://share/<id>"))`, then call `extensionContext.completeRequest`.

- [ ] **Step 2: Configure Orchestrel extension activation and entitlements**

Create an Info.plist using `NSExtensionPointIdentifier = com.apple.share-services`, principal class `$(PRODUCT_MODULE_NAME).ShareViewController`, and an activation predicate supporting web URL, web page, text, image, and file attachments with multiple items. Set the App Group entitlement to `group.com.orchestrel.ios.share`.

- [ ] **Step 3: Create the isolated Orc Chat extension**

Copy the implementation with only app group and scheme changed to `group.com.orchestrel.orcchat.ios.share` and `orcchat`. Use bundle display name `Orc Chat`; do not reference the Orchestrel App Group.

- [ ] **Step 4: Add extension targets to both Xcode projects**

For each `.pbxproj`, add:

- a `com.apple.product-type.app-extension` native target named `ShareExtension`;
- Swift source and Info.plist build references;
- Debug/Release configurations with iOS 15 minimum, Swift 5, the exact extension bundle ID, and `CODE_SIGN_ENTITLEMENTS`;
- an App target **Embed App Extensions** copy phase with `dstSubfolderSpec = 13`;
- a target dependency from App to ShareExtension;
- `APPLICATION_EXTENSION_API_ONLY = YES` on the extension.

Do not add Capacitor/Cordova package dependencies to the extension target.

- [ ] **Step 5: Compile both full projects including extensions**

Run:

```bash
(cd mobile/orchestrel/ios/App && xcodebuild -project App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO clean build)
(cd mobile/orc-chat/ios/App && xcodebuild -project App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO clean build)
```

Expected: both end in `** BUILD SUCCEEDED **`, and each built App bundle contains `PlugIns/ShareExtension.appex`.

Verify bundle contents:

```bash
find ~/Library/Developer/Xcode/DerivedData -path '*Build/Products/Debug-iphonesimulator/App.app/PlugIns/ShareExtension.appex' -print
```

Expected: one result for each project's DerivedData build location.

- [ ] **Step 6: Commit**

```bash
git add mobile/orchestrel/ios mobile/orc-chat/ios
git commit -m "feat: add Orchestrel iOS share extensions"
```

---

### Task 9: End-to-End Verification and Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/2026-07-24-ios-share-to-design.md` only if implementation discovered a factual correction

**Interfaces:**
- Verifies all prior task interfaces together; produces no new runtime abstraction.

- [ ] **Step 1: Run the complete automated suite**

Run:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

Expected: every command exits 0. Resolve failures rather than skipping checks.

- [ ] **Step 2: Rebuild both iOS apps from clean state**

Run:

```bash
(cd mobile/orchestrel && npm ci && npm run sync)
(cd mobile/orc-chat && npm ci && npm run sync)
(cd mobile/orchestrel/ios/App && xcodebuild -project App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO clean build)
(cd mobile/orc-chat/ios/App && xcodebuild -project App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO clean build)
```

Expected: sync succeeds and both builds end in `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Verify a remote-node initial attachment through the real stack**

With a connected non-local orcd node, create a draft card containing one small text file, move it to running, and verify logs show:

1. backend durable upload path;
2. `file_stage` to the card's configured node;
3. node-local `/tmp/orchestrel-attachments/<card>/<file>` path in the prompt;
4. pending refs cleared only after session creation;
5. agent can read the content.

Repeat a start after an induced staging failure and verify the same pending ref retries rather than disappearing.

- [ ] **Step 4: Perform physical-device share acceptance**

Install both signed apps on an iOS device and share from Safari, Photos, Files, and Notes:

- one URL;
- selected text plus URL;
- one image;
- one PDF;
- mixed multiple items;
- a file over 25 MB;
- a share while the target has unsaved commentary.

For each app verify the standard UI opens, URL/text is editable, files use attachment chips, existing commentary is not overwritten, cancel performs no upload/create, and explicit submit sends the initial attachments.

- [ ] **Step 5: Document operation and signing requirements**

Update README's iOS section with:

- both Share Extension bundle IDs and App Groups;
- requirement to enable matching App Group capabilities in the Apple Developer portal for app and extension provisioning profiles;
- `npm run sync` and Xcode open/build commands;
- private-distribution note for responder-chain app opening;
- 25 MB file limit and seven-day abandoned-inbox cleanup.

- [ ] **Step 6: Check repository cleanliness and generated files**

Run:

```bash
git status --short --ignored mobile | rg 'node_modules|App/public|capacitor.config.json|config.xml|DerivedData|\.swiftpm' || true
git diff --check
git status --short
```

Expected: generated artifacts appear only as ignored, `git diff --check` is clean, and only intended source/docs changes remain.

- [ ] **Step 7: Commit final documentation**

```bash
git add README.md docs/specs/2026-07-24-ios-share-to-design.md
git commit -m "docs: document iOS share targets"
```
