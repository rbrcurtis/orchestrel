# Model Per Conversation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to configure the Claude model (sonnet/opus) and thinking level (off/low/medium/high) per card, defaulting from a required project-level setting.

**Architecture:** Add two columns to both `projects` (defaults) and `cards` (per-card values). Cards copy project defaults at creation. `ClaudeSession` accepts these values and maps them to SDK opts. The `SessionView` status bar grows two inline selectors that persist changes to DB immediately.

**Tech Stack:** Drizzle ORM (SQLite), tRPC, React, shadcn Select, `@anthropic-ai/claude-agent-sdk`

---

### Task 1: Schema — add columns to projects and cards

**Files:**
- Modify: `src/server/db/schema.ts`

**Step 1: Add the new columns**

In `schema.ts`, add to the `projects` table after `defaultWorktree`:
```ts
defaultModel: text('default_model', { enum: ['sonnet', 'opus'] }).notNull().default('sonnet'),
defaultThinkingLevel: text('default_thinking_level', { enum: ['off', 'low', 'medium', 'high'] }).notNull().default('high'),
```

Add to the `cards` table after `sourceBranch`:
```ts
model: text('model', { enum: ['sonnet', 'opus'] }).notNull().default('sonnet'),
thinkingLevel: text('thinking_level', { enum: ['off', 'low', 'medium', 'high'] }).notNull().default('high'),
```

**Step 2: Push schema to DB (backfills existing rows via column defaults)**

```bash
pnpm db:push
```

Expected: prompts for confirmation, applies migration, no errors.

**Step 3: Commit**

```bash
git add src/server/db/schema.ts
git commit -m "feat: add model+thinkingLevel to projects and cards schema"
```

---

### Task 2: Backend — ClaudeSession accepts model + thinkingLevel

**Files:**
- Modify: `src/server/claude/protocol.ts`

**Step 1: Update constructor signature**

Add `model` and `thinkingLevel` parameters to the constructor (with defaults for safety):

```ts
constructor(
  private cwd: string,
  private resumeSessionId?: string,
  private projectName?: string,
  private model: 'sonnet' | 'opus' = 'sonnet',
  private thinkingLevel: 'off' | 'low' | 'medium' | 'high' = 'high',
) {
  super();
}
```

**Step 2: Replace the hardcoded model/thinking/effort in `runQuery()`**

Replace lines 78–80:
```ts
model: 'claude-sonnet-4-6',
thinking: { type: 'adaptive' },
effort: 'high',
```

With:
```ts
model: this.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
thinking: this.thinkingLevel === 'off' ? { type: 'disabled' } : { type: 'adaptive' },
effort: this.thinkingLevel === 'off' ? 'low' : this.thinkingLevel,
```

**Step 3: Commit**

```bash
git add src/server/claude/protocol.ts
git commit -m "feat: ClaudeSession accepts model and thinkingLevel"
```

---

### Task 3: Backend — SessionManager.create() passes model + thinkingLevel

**Files:**
- Modify: `src/server/claude/manager.ts`

**Step 1: Update `create()` signature**

```ts
create(
  cardId: number,
  cwd: string,
  resumeSessionId?: string,
  projectName?: string,
  model: 'sonnet' | 'opus' = 'sonnet',
  thinkingLevel: 'off' | 'low' | 'medium' | 'high' = 'high',
): ClaudeSession {
  // ...existing guard...
  const session = new ClaudeSession(cwd, resumeSessionId, projectName, model, thinkingLevel);
```

**Step 2: Commit**

```bash
git add src/server/claude/manager.ts
git commit -m "feat: SessionManager.create() passes model and thinkingLevel"
```

---

### Task 4: Backend — projects router exposes defaultModel + defaultThinkingLevel

**Files:**
- Modify: `src/server/routers/projects.ts`

**Step 1: Add to `create` input schema**

```ts
defaultModel: z.enum(['sonnet', 'opus']).optional().default('sonnet'),
defaultThinkingLevel: z.enum(['off', 'low', 'medium', 'high']).optional().default('high'),
```

**Step 2: Add to `update` input schema**

```ts
defaultModel: z.enum(['sonnet', 'opus']).optional(),
defaultThinkingLevel: z.enum(['off', 'low', 'medium', 'high']).optional(),
```

(These are already spread into `values`/`set` via `...input` / `...data`, so no other changes needed.)

**Step 3: Commit**

```bash
git add src/server/routers/projects.ts
git commit -m "feat: projects router exposes defaultModel and defaultThinkingLevel"
```

---

### Task 5: Backend — cards router copies project defaults on create; update accepts model + thinkingLevel

**Files:**
- Modify: `src/server/routers/cards.ts`

**Step 1: Add model + thinkingLevel to `update` input**

In the `update` procedure's input schema, add:
```ts
model: z.enum(['sonnet', 'opus']).optional(),
thinkingLevel: z.enum(['off', 'low', 'medium', 'high']).optional(),
```

**Step 2: Inherit project defaults in `create`**

In the `create` mutation, after the existing project lookup block (around line 39), add logic to copy `defaultModel` and `defaultThinkingLevel` from the project into `extra`:

```ts
// After the existing worktree setup block:
if (input.projectId) {
  const [proj] = existing project lookup result (reuse if already fetched above)
  // Note: project may already be fetched in the worktree block — extract it
  if (proj) {
    extra.model = proj.defaultModel ?? 'sonnet';
    extra.thinkingLevel = proj.defaultThinkingLevel ?? 'high';
  }
}
```

The project lookup already exists inside the `if (col === 'in_progress' && input.projectId)` block. Refactor slightly to also run when `input.projectId` is set regardless of column, so defaults are always copied:

```ts
// Replace the inner project fetch in the `in_progress` block with a shared fetch:
let project: typeof projects.$inferSelect | undefined;
if (input.projectId) {
  const [proj] = await ctx.db.select().from(projects).where(eq(projects.id, input.projectId));
  if (proj) {
    project = proj;
    extra.model = proj.defaultModel;
    extra.thinkingLevel = proj.defaultThinkingLevel;
  }
}

// Then the in_progress worktree setup reuses `project`:
if (col === 'in_progress' && project) {
  // ...existing worktree logic...
}
```

**Step 3: Commit**

```bash
git add src/server/routers/cards.ts
git commit -m "feat: cards inherit model+thinkingLevel from project on create"
```

---

### Task 6: Backend — claude router passes card's model + thinkingLevel to sessionManager

**Files:**
- Modify: `src/server/routers/claude.ts`

**Step 1: Update `start` mutation — pass card.model and card.thinkingLevel**

In the `start` mutation, change the `sessionManager.create()` call (around line 54):
```ts
const session = sessionManager.create(
  input.cardId,
  card.worktreePath,
  card.sessionId ?? undefined,
  projectName,
  card.model,
  card.thinkingLevel,
);
```

**Step 2: Update `sendMessage` mutation — pass card.model and card.thinkingLevel on re-create**

In the `sendMessage` mutation, the session-recreation block (around line 132) also calls `sessionManager.create()`. Update it the same way:

First, add `model` and `thinkingLevel` to the select from cards:
```ts
const [card] = await ctx.db.select().from(cards).where(eq(cards.id, input.cardId));
// card now has model and thinkingLevel
```

Then pass them to `sessionManager.create()`:
```ts
session = sessionManager.create(
  input.cardId,
  card.worktreePath,
  card.sessionId,
  projectName,
  card.model,
  card.thinkingLevel,
);
```

**Step 3: Commit**

```bash
git add src/server/routers/claude.ts
git commit -m "feat: claude router passes model+thinkingLevel to sessions"
```

---

### Task 7: UI — project form adds defaultModel + defaultThinkingLevel selectors

**Files:**
- Modify: `app/components/ProjectForm.tsx`

**Step 1: Add state and form fields**

Add state:
```ts
const [defaultModel, setDefaultModel] = useState<'sonnet' | 'opus'>(project?.defaultModel ?? 'sonnet');
const [defaultThinkingLevel, setDefaultThinkingLevel] = useState<'off' | 'low' | 'medium' | 'high'>(project?.defaultThinkingLevel ?? 'high');
```

Update the `Project` interface to include the new fields:
```ts
defaultModel: 'sonnet' | 'opus';
defaultThinkingLevel: 'off' | 'low' | 'medium' | 'high';
```

**Step 2: Add selectors to the form**

Add after the "Default Branch" / worktree section, before the submit button area:

```tsx
{/* Model */}
<div>
  <label className="block text-sm font-medium text-muted-foreground mb-1">Default Model</label>
  <Select value={defaultModel} onValueChange={(v) => setDefaultModel(v as 'sonnet' | 'opus')}>
    <SelectTrigger className="w-full">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="sonnet">Sonnet 4.6</SelectItem>
      <SelectItem value="opus">Opus 4.6</SelectItem>
    </SelectContent>
  </Select>
</div>

{/* Thinking Level */}
<div>
  <label className="block text-sm font-medium text-muted-foreground mb-1">Default Thinking</label>
  <Select value={defaultThinkingLevel} onValueChange={(v) => setDefaultThinkingLevel(v as 'off' | 'low' | 'medium' | 'high')}>
    <SelectTrigger className="w-full">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="off">Off</SelectItem>
      <SelectItem value="low">Low</SelectItem>
      <SelectItem value="medium">Medium</SelectItem>
      <SelectItem value="high">High</SelectItem>
    </SelectContent>
  </Select>
</div>
```

**Step 3: Pass values in handleSubmit**

In `handleSubmit`, add to the `data` object:
```ts
defaultModel,
defaultThinkingLevel,
```

**Step 4: Commit**

```bash
git add app/components/ProjectForm.tsx
git commit -m "feat: project form includes defaultModel and defaultThinkingLevel"
```

---

### Task 8: UI — SessionView status bar adds inline model + thinking selectors

**Files:**
- Modify: `app/components/SessionView.tsx`

**Step 1: Update SessionView Props**

Add to the `Props` type:
```ts
cardId: number;
sessionId?: string | null;
accentColor?: string | null;
model: 'sonnet' | 'opus';
thinkingLevel: 'off' | 'low' | 'medium' | 'high';
```

**Step 2: Add an update mutation**

Inside `SessionView`, add:
```ts
const updateCardMutation = useMutation(
  trpc.cards.update.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
    },
  })
);
```

**Step 3: Add selectors to the status bar**

The status bar is the `div` around line 337–358 (the one containing `StatusBadge`, turn counters, and the Stop button). Add the two selectors on the left side, between the turn counters and the stop button:

```tsx
{/* Model selector */}
<select
  value={model}
  onChange={(e) => updateCardMutation.mutate({ id: cardId, model: e.target.value as 'sonnet' | 'opus' })}
  className="text-[11px] bg-transparent text-muted-foreground border-none outline-none cursor-pointer hover:text-foreground"
>
  <option value="sonnet">Sonnet</option>
  <option value="opus">Opus</option>
</select>

{/* Thinking selector */}
<select
  value={thinkingLevel}
  onChange={(e) => updateCardMutation.mutate({ id: cardId, thinkingLevel: e.target.value as 'off' | 'low' | 'medium' | 'high' })}
  className="text-[11px] bg-transparent text-muted-foreground border-none outline-none cursor-pointer hover:text-foreground"
>
  <option value="off">Off</option>
  <option value="low">Low</option>
  <option value="medium">Medium</option>
  <option value="high">High</option>
</select>
```

Note: Use native `<select>` rather than shadcn Select to keep these tiny and inline. Style to match the `text-[11px] text-muted-foreground` style of the turn counter.

**Step 4: Find where SessionView is rendered and pass the new props**

Search for `<SessionView` usages:
```bash
grep -r "SessionView" app/ --include="*.tsx" -l
```

Then pass `model` and `thinkingLevel` from the card data at each callsite.

**Step 5: Commit**

```bash
git add app/components/SessionView.tsx
git commit -m "feat: SessionView status bar includes model+thinking selectors"
```

---

### Task 9: Wire SessionView callsite(s) — pass model + thinkingLevel from card

**Files:**
- Modify: `app/components/CardDetail.tsx` (and any other callsite found in Task 8 Step 4)

**Step 1: Read CardDetail.tsx to find how card data is passed**

The card object should already be available in `CardDetail`. Add `model` and `thinkingLevel` to the props passed to `<SessionView>`:

```tsx
<SessionView
  cardId={card.id}
  sessionId={card.sessionId}
  accentColor={card.accentColor}
  model={card.model ?? 'sonnet'}
  thinkingLevel={card.thinkingLevel ?? 'high'}
/>
```

**Step 2: Commit**

```bash
git add app/components/CardDetail.tsx
git commit -m "feat: pass model+thinkingLevel from card to SessionView"
```

---

### Task 10: Verify end-to-end

**Step 1: Restart service to pick up server changes**

```bash
sudo systemctl restart orchestrel
```

**Step 2: Manual smoke test**

1. Open a project settings — confirm Model and Thinking selectors appear with correct defaults
2. Create a new card on that project — confirm it inherits the project's model/thinking
3. Open the card detail — in the session status bar, change the model/thinking selectors
4. Start a session — confirm the correct model is used (check server logs or `data/sessions/*.jsonl` for the `system` message)
5. During a running session, change the thinking level — send a follow-up message — verify the new turn uses the updated settings

**Step 3: Commit any fixes found**
