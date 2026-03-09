# File Upload Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users attach files (images, PDFs, docs, code) to chat messages so Claude can review them.

**Architecture:** Separate Express upload endpoint saves files to `/tmp/dispatcher-uploads/{sessionId}/`. tRPC `sendMessage` extended to accept file references. Server prepends file paths to the text prompt so Claude Code reads them via its native Read tool. UI gets paperclip button, drag-and-drop, clipboard paste, and file chips.

**Tech Stack:** multer (file upload middleware), Express route, React (file input, drag/drop, paste handlers)

---

### Task 1: Install multer dependency

**Files:**
- Modify: `package.json`

**Step 1: Install multer and types**

```bash
pnpm add multer @types/multer
```

**Step 2: Verify installation**

```bash
pnpm ls multer
```

Expected: `multer@1.x.x`

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add multer for file upload support"
```

---

### Task 2: Create upload Express route

**Files:**
- Create: `src/server/upload.ts`
- Modify: `server/app.ts:11-22` (add upload route before React Router catch-all)

**Step 1: Create the upload route module**

Create `src/server/upload.ts`:

```typescript
import { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const MAX_FILES = 10;

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const sessionId = req.body?.sessionId || 'unsorted';
    const dir = join('/tmp/dispatcher-uploads', sessionId);
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const id = randomUUID().slice(0, 8);
    cb(null, `${id}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
});

export const uploadRouter = Router();

uploadRouter.post('/api/upload', upload.array('files', MAX_FILES), (req, res) => {
  const files = req.files as Express.Multer.File[];
  if (!files?.length) {
    res.status(400).json({ error: 'No files uploaded' });
    return;
  }

  const refs = files.map((f) => ({
    id: f.filename.slice(0, 8),
    name: f.originalname,
    mimeType: f.mimetype,
    path: f.path,
    size: f.size,
  }));

  res.json({ files: refs });
});
```

**Step 2: Wire into server/app.ts**

Modify `server/app.ts` to add the upload route before the React Router catch-all:

```typescript
import "react-router";
import { createRequestHandler } from "@react-router/express";
import express from "express";
import { uploadRouter } from "../src/server/upload";

declare module "react-router" {
  interface AppLoadContext {
    VALUE_FROM_EXPRESS: string;
  }
}

export const app = express();

// File upload route (before React Router catch-all)
app.use(uploadRouter);

app.use(
  createRequestHandler({
    build: () => import("virtual:react-router/server-build"),
    getLoadContext() {
      return {
        VALUE_FROM_EXPRESS: "Hello from Express",
      };
    },
  }),
);
```

**Step 3: Test manually**

```bash
curl -X POST http://192.168.4.200:6194/api/upload \
  -F "sessionId=test-session" \
  -F "files=@/tmp/test.txt"
```

Expected: JSON response with file ref including `id`, `name`, `mimeType`, `path`, `size`.

**Step 4: Verify file on disk**

```bash
ls /tmp/dispatcher-uploads/test-session/
```

Expected: file exists with UUID prefix.

**Step 5: Commit**

```bash
git add src/server/upload.ts server/app.ts
git commit -m "feat: add file upload Express endpoint"
```

---

### Task 3: Extend tRPC sendMessage to accept file refs

**Files:**
- Modify: `src/server/routers/claude.ts:103-162`
- Modify: `src/server/claude/protocol.ts:156-172`

**Step 1: Update sendMessage input schema**

In `src/server/routers/claude.ts`, change the `sendMessage` input to accept an optional files array:

```typescript
// At top of file, add schema
const fileRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  path: z.string(),
  size: z.number(),
});

// In sendMessage procedure, change input to:
sendMessage: publicProcedure
  .input(z.object({
    cardId: z.number(),
    message: z.string().min(1),
    files: z.array(fileRefSchema).optional(),
  }))
```

**Step 2: Build prompt with file paths**

In the `sendMessage` mutation handler, before calling `session.sendUserMessage()`, prepend file paths to the prompt:

```typescript
let prompt = input.message;
if (input.files?.length) {
  const fileList = input.files
    .map((f) => `- ${f.path} (${f.name}, ${f.mimeType})`)
    .join('\n');
  prompt = `I've attached the following files for you to review. Use the Read tool to read them:\n${fileList}\n\n${prompt}`;
}
await session.sendUserMessage(prompt);
```

**Step 3: Verify the existing flow still works**

Restart the service and send a text-only message through the UI. Confirm it works as before (no files = no prefix).

**Step 4: Commit**

```bash
git add src/server/routers/claude.ts
git commit -m "feat: extend sendMessage to accept file references"
```

---

### Task 4: Add file state and upload logic to PromptInput

**Files:**
- Modify: `app/components/SessionView.tsx:398-480`

**Step 1: Update PromptInput props and state**

Extend the component to manage file state:

```typescript
function PromptInput({
  cardId,
  isRunning,
  hasSession,
  isPending,
  onStart,
  onSend,
  sendPending,
  contextPercent,
  compacted,
}: {
  cardId: number;
  isRunning: boolean;
  hasSession: boolean;
  isPending: boolean;
  onStart: (prompt: string) => void;
  onSend: (message: string, files?: FileRef[]) => void;
  sendPending: boolean;
  contextPercent: number;
  compacted: boolean;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
```

**Step 2: Add file upload function**

```typescript
type FileRef = {
  id: string;
  name: string;
  mimeType: string;
  path: string;
  size: number;
};

async function uploadFiles(files: File[], sessionId?: string): Promise<FileRef[]> {
  const form = new FormData();
  if (sessionId) form.append('sessionId', sessionId);
  for (const f of files) form.append('files', f);

  const res = await fetch('/api/upload', { method: 'POST', body: form });
  if (!res.ok) throw new Error('Upload failed');
  const data = await res.json();
  return data.files;
}
```

Place this helper above the PromptInput component (or inside it).

**Step 3: Update handleSubmit**

```typescript
async function handleSubmit(e: React.FormEvent) {
  e.preventDefault();
  const trimmed = text.trim();
  if (!trimmed && files.length === 0) return;

  if (isRunning || hasSession) {
    if (files.length > 0) {
      // Upload files, then send message with refs
      try {
        const refs = await uploadFiles(files);
        onSend(trimmed || 'Please review the attached files.', refs);
      } catch {
        // TODO: show error toast
        return;
      }
    } else {
      onSend(trimmed);
    }
  } else {
    onStart(trimmed);
  }
  setText('');
  setFiles([]);
}
```

**Step 4: Add file handling functions**

```typescript
function addFiles(newFiles: FileList | File[]) {
  const arr = Array.from(newFiles).filter((f) => f.size <= 25 * 1024 * 1024);
  setFiles((prev) => [...prev, ...arr]);
}

function removeFile(idx: number) {
  setFiles((prev) => prev.filter((_, i) => i !== idx));
}

function handlePaste(e: React.ClipboardEvent) {
  const items = Array.from(e.clipboardData.items);
  const imageFiles = items
    .filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
  if (imageFiles.length > 0) {
    e.preventDefault();
    addFiles(imageFiles);
  }
}

function handleDrop(e: React.DragEvent) {
  e.preventDefault();
  setDragging(false);
  if (e.dataTransfer.files.length > 0) {
    addFiles(e.dataTransfer.files);
  }
}
```

**Step 5: Update the onSend callback in the parent**

In the main SessionView component (around line 359), update the `onSend` prop to pass files through to the mutation:

```typescript
onSend={(message, files) => sendMutation.mutate({ cardId, message, files })}
```

And update the `onSend` prop type:

```typescript
onSend: (message: string, files?: FileRef[]) => void;
```

**Step 6: Commit**

```bash
git add app/components/SessionView.tsx
git commit -m "feat: add file upload state and logic to PromptInput"
```

---

### Task 5: Build the file upload UI

**Files:**
- Modify: `app/components/SessionView.tsx:449-480` (the JSX return of PromptInput)

**Step 1: Add drag state**

```typescript
const [dragging, setDragging] = useState(false);
```

**Step 2: Update the JSX**

Replace the current PromptInput return with:

```tsx
return (
  <form
    onSubmit={handleSubmit}
    className="px-3 py-2 border-t border-border bg-muted shrink-0"
    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
    onDragLeave={() => setDragging(false)}
    onDrop={handleDrop}
  >
    {/* File chips row */}
    {files.length > 0 && (
      <div className="flex flex-wrap gap-1.5 mb-2 justify-end pr-[46px] sm:pr-[38px]">
        {files.map((f, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-elevated text-xs text-muted-foreground border border-border"
          >
            <span className="max-w-[120px] truncate">{f.name}</span>
            <button
              type="button"
              onClick={() => removeFile(i)}
              className="text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}
      </div>
    )}
    <div className={`flex gap-2 ${dragging ? 'ring-2 ring-neon-cyan/50 rounded-md' : ''}`}>
      <div className="relative flex-1">
        <Textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isRunning ? 'Send a follow-up message...' : 'Enter a prompt to start a session...'}
          maxLength={10000}
          rows={3}
          className="resize-none min-h-[106px] sm:min-h-0 pr-10"
        />
        {/* Paperclip button - bottom right inside textarea */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="absolute bottom-2 right-2 text-muted-foreground hover:text-foreground transition-colors"
          title="Attach files"
        >
          <Paperclip className="size-4" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      <div className="flex flex-col items-center justify-end gap-1.5">
        <ContextGauge
          percent={contextPercent}
          compacted={compacted}
          onCompact={hasSession ? () => onSend('/compact') : undefined}
        />
        <Button
          type="submit"
          disabled={disabled}
          className="size-[50px] sm:size-[34px] p-0"
        >
          <Send className="size-5 sm:size-4" />
        </Button>
      </div>
    </div>
  </form>
);
```

**Step 3: Add Paperclip import**

At the top of `SessionView.tsx`, add `Paperclip` to the lucide-react import:

```typescript
import { Send, Square, AlertCircle, ChevronDown, Paperclip } from 'lucide-react';
```

**Step 4: Update disabled logic**

```typescript
const disabled = isPending || sendPending || (!text.trim() && files.length === 0);
```

**Step 5: Visually verify**

Open the UI, confirm:
- Paperclip icon visible bottom-right of textarea
- Clicking opens file picker
- Drag-and-drop shows ring highlight
- Pasting an image adds a file chip
- File chips appear right-aligned above textarea
- Chips clear after send

**Step 6: Commit**

```bash
git add app/components/SessionView.tsx
git commit -m "feat: file upload UI with paperclip, drag-drop, and paste"
```

---

### Task 6: Show file attachments in chat history (UserBlock)

**Files:**
- Modify: `app/components/MessageBlock.tsx:317-353`

**Step 1: Detect file attachment messages**

In `UserBlock`, parse the message text to detect file attachment prefixes and extract filenames:

```typescript
function UserBlock({ message, accentColor }: { message: Record<string, unknown>; accentColor?: string | null }) {
  const inner = message.message as { content?: unknown } | undefined;
  if (!inner?.content) return null;

  let text: string | null = null;
  if (typeof inner.content === 'string') {
    text = inner.content;
  } else if (Array.isArray(inner.content)) {
    const parts = (inner.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!);
    if (parts.length > 0) text = parts.join('\n');
  }

  if (!text) return null;

  if (text.includes('<command-name>') || text.includes('<local-command-') || text.includes('<system-reminder>')) {
    return null;
  }

  // Extract file attachments from prompt prefix
  const fileMatch = text.match(/^I've attached the following files for you to review\. Use the Read tool to read them:\n((?:- .+\n)+)\n([\s\S]*)$/);
  let attachedFiles: { name: string; mimeType: string }[] = [];
  let displayText = text;

  if (fileMatch) {
    const fileLines = fileMatch[1].trim().split('\n');
    attachedFiles = fileLines.map((line) => {
      const m = line.match(/^- .+\/[\w-]+-(.+?) \((.+?), (.+?)\)$/);
      return m ? { name: m[2], mimeType: m[3] } : { name: line, mimeType: '' };
    });
    displayText = fileMatch[2] || '';
  }

  const accentVar = accentColor ? `var(--${accentColor})` : 'var(--neon-cyan)';

  return (
    <div className="flex justify-end my-2">
      <div
        className="group relative text-sm text-foreground bg-elevated rounded-lg px-3 py-2 max-w-[85%] border-l-2"
        style={{ borderLeftColor: accentVar }}
      >
        <CopyButton text={displayText || text} />
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachedFiles.map((f, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted text-xs text-muted-foreground border border-border"
              >
                {f.name}
              </span>
            ))}
          </div>
        )}
        {displayText && <Markdown text={displayText} linkColor={accentVar} />}
      </div>
    </div>
  );
}
```

**Step 2: Verify in UI**

Send a message with files attached. The UserBlock should show:
- File chips at the top of the message bubble
- The actual message text below (without the file prefix boilerplate)

**Step 3: Commit**

```bash
git add app/components/MessageBlock.tsx
git commit -m "feat: show file attachment chips in chat history"
```

---

### Task 7: End-to-end test

**Step 1: Restart the service**

```bash
sudo systemctl restart dispatcher
```

**Step 2: Test text-only message (regression)**

Send a regular text message to an existing session. Confirm it works exactly as before.

**Step 3: Test file upload flow**

1. Open a card with an active session
2. Click the paperclip icon, select a text file
3. Add a message like "Review this file"
4. Send — confirm Claude receives the file path and reads it

**Step 4: Test image upload**

1. Paste a screenshot from clipboard into the prompt
2. Send — confirm Claude reads the image via its Read tool (multimodal)

**Step 5: Test multiple files**

1. Drag-and-drop 2-3 files onto the textarea
2. Confirm all appear as chips
3. Remove one chip, send the rest
4. Confirm Claude acknowledges all files

**Step 6: Test 25 MB limit**

1. Try attaching a file > 25 MB
2. Confirm it's silently rejected (not added to chips)

**Step 7: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: file upload polish from e2e testing"
```
