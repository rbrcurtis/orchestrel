# Orchestrel Subagent Model Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace project-level `.pi/agents/*.md` generation with an Orchestrel-owned Pi extension that selects provider-correct subagent models for both orcd and `orc`.

**Architecture:** Orchestrel builds a provider-specific policy and installs a resolver on each Pi runtime's event bus. Our pi-subagents fork asks that resolver at its shared spawn boundary, resolves the returned fully qualified model exactly, and rejects explicit cross-provider models before spawning. orcd passes policy in memory through a session-local `DefaultResourceLoader`; `orc` passes policy through a private process environment variable and loads the same extension with `-e`.

**Tech Stack:** TypeScript, Bun, Vitest, Pi extension APIs, `@earendil-works/pi-coding-agent` 0.80.3, pi-subagents fork

## Global Constraints

- Support both the Orchestrel app/orcd and the standalone `orc` wrapper; unwrapped Pi is outside scope.
- Explicit `Agent(model: ...)` overrides are allowed only when the resolved model uses the parent provider.
- No cross-provider subagent routing in this version.
- Never create or overwrite project `.pi/agents/*.md` files.
- Cleanup may delete only files containing `managed_by: orchestrel`; preserve all unmarked files and unrelated `.pi` resources.
- orcd policies must be session-local so concurrent sessions using different providers cannot interfere.
- Policy-selected models must use exact, fully qualified `provider/modelID` identities.
- Keep `@earendil-works/pi-coding-agent` pinned at exactly `0.80.3`.
- Do not restart services during implementation unless explicitly requested.
- The current working tree contains a separate verified UI tracking fix in `src/orcd/pi-events.ts`, `src/orcd/__tests__/pi-events.test.ts`, `app/lib/message-accumulator.ts`, and `app/lib/message-accumulator.test.ts`. Commit or stash that work separately before implementing this plan; never discard or mix it into policy commits.

---

## File Structure

### pi-subagents fork (`/home/ryan/Code/pi-subagents`)

- Create `src/model-policy.ts` — event-bus request contract, explicit-model normalization, policy decision validation, and exact model lookup.
- Create `test/model-policy.test.ts` — pure contract and model-selection regression tests.
- Modify `src/agent-manager.ts` — apply policy once at the shared spawn boundary before queueing or execution.
- Modify `src/types.ts` — retain requested/effective model identity in spawn/record types where needed.
- Modify `src/index.ts` — pass the explicit Agent parameter as `requestedModel`; remove duplicated final model policy work.
- Modify `src/schedule.ts` — pass scheduled model text as `requestedModel` instead of resolving it separately.
- Modify `src/cross-extension-rpc.ts` — pass RPC model text to the shared boundary instead of resolving it separately.
- Modify `src/default-agents.ts` — remove the embedded Anthropic Explore model pin.
- Modify focused tests in `test/invocation-config.test.ts`, `test/agent-manager.test.ts`, `test/schedule.test.ts`, and `test/cross-extension-rpc.test.ts`.

### Orchestrel (`/home/ryan/Code/orchestrel`)

- Create `src/shared/subagent-policy.ts` — policy types, provider mapping, serialization, and safe legacy cleanup.
- Create `src/shared/subagent-policy.test.ts` — aliases, positional fallback, overrides, serialization, and cleanup tests.
- Create `src/pi-extensions/orchestrel-subagent-policy.ts` — default env-backed extension plus factory for in-memory orcd use.
- Create `src/pi-extensions/orchestrel-subagent-policy.test.ts` — request decisions, provider enforcement, malformed policy, and independent bus behavior.
- Modify `src/orcd/pi-runtime.ts` — build a session-local event bus/resource loader and install the policy factory.
- Modify `src/orcd/pi-runtime.test.ts` — assert runtime loader wiring and no project writes.
- Modify `bin/orc` — load the extension with `-e`, provide serialized policy in child env, and run safe legacy cleanup.
- Modify `bin/orc.test.ts` — assert argv/env contract and clean-project behavior with a stub Pi executable.
- Modify `src/orcd/config.ts` and `src/shared/config.ts` — use shared policy types/comments instead of old generated-file types.
- Delete `src/orcd/subagent-agents.ts` and `src/orcd/__tests__/subagent-agents.test.ts` after all consumers migrate.

---

### Task 1: Add the pi-subagents Runtime Policy Contract

**Repository:** `/home/ryan/Code/pi-subagents`

**Files:**
- Create: `src/model-policy.ts`
- Create: `test/model-policy.test.ts`
- Modify: `src/agent-manager.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: Pi `ExtensionAPI.events`, `ExtensionContext.modelRegistry`, and `ExtensionContext.model`.
- Produces:

```ts
export const SUBAGENT_MODEL_POLICY_CHANNEL = "subagents:model-policy";

export interface SubagentModelPolicyRequest {
  agentType: string;
  requestedModel?: string;
  parentProvider: string;
  parentModel: string;
  decision?: SubagentModelPolicyDecision;
}

export type SubagentModelPolicyDecision =
  | { model: string; source: string }
  | { error: string };

export function selectSpawnModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agentType: string,
  requestedModel?: string,
  fallbackModel?: Model<unknown>,
): { model: Model<unknown>; source?: string };
```

- `AgentManager.spawn()` accepts `SpawnOptions.requestedModel?: string` and invokes `selectSpawnModel()` synchronously before creating or queueing the record.
- `AgentRecord` stores the selected `Model` object as it does today; resumed agents reuse their existing session/model and do not resolve policy again.

- [ ] **Step 1: Write failing contract tests**

Create `test/model-policy.test.ts` with these behavior cases:

```ts
it("uses an explicit same-provider model before the policy mapping", () => {
  const { pi, ctx, models } = fixture("trackable", ["auto", "claude-sonnet-4-6"]);
  installPolicy(pi.events, (req) => {
    expect(req.requestedModel).toBe("trackable/claude-sonnet-4-6");
    req.decision = { model: req.requestedModel!, source: "explicit" };
  });

  expect(selectSpawnModel(pi, ctx, "Explore", "sonnet").model).toBe(models.sonnet);
});

it("uses the policy-selected exact model when no explicit model is supplied", () => {
  const { pi, ctx, models } = fixture("trackable", ["auto", "claude-opus-4-6"]);
  installPolicy(pi.events, (req) => {
    req.decision = { model: "trackable/claude-opus-4-6", source: "lightweight tier" };
  });

  expect(selectSpawnModel(pi, ctx, "Explore").model).toBe(models.opus);
});

it("throws a policy rejection before spawn", () => {
  const { pi, ctx } = fixture("trackable", ["auto"]);
  installPolicy(pi.events, (req) => {
    req.decision = { error: 'Subagent model "anthropic/claude-haiku-4-5" is not allowed. This session uses provider "trackable".' };
  });

  expect(() => selectSpawnModel(pi, ctx, "Explore", "anthropic/claude-haiku-4-5"))
    .toThrow('This session uses provider "trackable"');
});

it("falls back to the supplied model or parent when no policy is installed", () => {
  const { pi, ctx, models } = fixture("trackable", ["auto", "claude-sonnet-4-6"]);
  expect(selectSpawnModel(pi, ctx, "Explore", undefined, models.sonnet).model).toBe(models.sonnet);
  expect(selectSpawnModel(pi, ctx, "Explore").model).toBe(models.auto);
});

it("rejects malformed decisions and unknown exact policy models", () => {
  // Assert separate errors for an envelope containing both model+error and for
  // policy model trackable/missing, rather than silently inheriting the parent.
});
```

These tests are worth retaining because the policy parser/model selector is a pure provider boundary where a silent fallback can execute work on the wrong model or provider.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
cd /home/ryan/Code/pi-subagents
npx vitest run test/model-policy.test.ts
```

Expected: FAIL because `src/model-policy.ts` and `selectSpawnModel()` do not exist.

- [ ] **Step 3: Implement the synchronous request contract**

In `src/model-policy.ts`:

```ts
export function selectSpawnModel(pi, ctx, agentType, requestedModel, fallbackModel) {
  let explicit: Model<unknown> | undefined;
  if (requestedModel) {
    const resolved = resolveModel(requestedModel, ctx.modelRegistry);
    if (typeof resolved === "string") throw new Error(resolved);
    explicit = resolved;
  }

  const parent = ctx.model;
  if (!parent) throw new Error("Cannot select a subagent model without a parent model");

  const request: SubagentModelPolicyRequest = {
    agentType,
    ...(explicit ? { requestedModel: `${explicit.provider}/${explicit.id}` } : {}),
    parentProvider: parent.provider,
    parentModel: `${parent.provider}/${parent.id}`,
  };
  pi.events.emit(SUBAGENT_MODEL_POLICY_CHANNEL, request);

  if (!request.decision) return { model: explicit ?? fallbackModel ?? parent };
  if ("error" in request.decision) throw new Error(request.decision.error);

  const slash = request.decision.model.indexOf("/");
  if (slash <= 0) throw new Error(`Invalid subagent policy model: "${request.decision.model}"`);
  const provider = request.decision.model.slice(0, slash);
  const modelId = request.decision.model.slice(slash + 1);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Subagent policy model not found: "${request.decision.model}"`);
  return { model, source: request.decision.source };
}
```

Validate the decision as an exclusive union at runtime: non-empty `model` and `source`, or non-empty `error`, never both.

- [ ] **Step 4: Apply selection in `AgentManager.spawn()` before queueing**

Add `requestedModel?: string` to `SpawnOptions`. At the top of `spawn()`, before the queue branch and record creation, derive:

```ts
const selected = selectSpawnModel(pi, ctx, type, options.requestedModel, options.model);
const effectiveOptions = { ...options, model: selected.model };
```

Use `effectiveOptions` for both queued and immediate `SpawnArgs`. Store the selected model in the invocation snapshot so queued jobs cannot be affected by a later policy/model change.

- [ ] **Step 5: Run focused policy and manager tests**

Run:

```bash
npx vitest run test/model-policy.test.ts test/agent-manager.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the shared spawn-boundary hook**

```bash
git add src/model-policy.ts src/agent-manager.ts src/types.ts test/model-policy.test.ts test/agent-manager.test.ts
git commit -m "feat: add runtime subagent model policy hook"
```

---

### Task 2: Route Every pi-subagents Spawn Path Through the Policy

**Repository:** `/home/ryan/Code/pi-subagents`

**Files:**
- Modify: `src/index.ts`
- Modify: `src/invocation-config.ts`
- Modify: `src/default-agents.ts`
- Modify: `src/schedule.ts`
- Modify: `src/cross-extension-rpc.ts`
- Modify: `test/invocation-config.test.ts`
- Modify: `test/schedule.test.ts`
- Modify: `test/cross-extension-rpc.test.ts`
- Modify: `test/status-note-wiring.test.ts`

**Interfaces:**
- Consumes: `AgentManager.spawn(..., { requestedModel?: string, model?: Model })` from Task 1.
- Produces: every new subagent creation conveys the caller's model text to the manager; no path resolves a policy model independently.

- [ ] **Step 1: Write failing precedence and path tests**

Update tests to require:

```ts
it("lets the explicit Agent model parameter outrank agent config", () => {
  const resolved = resolveAgentInvocationConfig(
    { model: "provider/config-model" } as AgentConfig,
    { model: "provider/explicit-model" },
  );
  expect(resolved.modelInput).toBe("provider/explicit-model");
  expect(resolved.modelFromParams).toBe(true);
});
```

For schedule and RPC tests, assert the manager receives model text without early resolution:

```ts
expect(manager.spawn).toHaveBeenCalledWith(
  pi,
  ctx,
  "Explore",
  expect.any(String),
  expect.objectContaining({ requestedModel: "trackable/claude-opus-4-6" }),
);
```

In `test/status-note-wiring.test.ts`, execute the registered Agent tool with `{ model: "trackable/claude-sonnet-4-6" }` and assert the captured `AgentManager.spawnAndWait()` options contain `requestedModel: "trackable/claude-sonnet-4-6"`.

These tests are worth retaining because separate spawn paths previously had divergent fallback/error behavior; one missed path would bypass same-provider enforcement.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npx vitest run test/invocation-config.test.ts test/schedule.test.ts test/cross-extension-rpc.test.ts
```

Expected: FAIL because config currently outranks explicit params and schedule/RPC resolve model strings before `AgentManager`.

- [ ] **Step 3: Make explicit tool parameters win**

Change `resolveAgentInvocationConfig()` to:

```ts
const explicitModel = params.model;
return {
  modelInput: explicitModel ?? agentConfig?.model,
  modelFromParams: explicitModel != null,
  // existing non-model fields remain unchanged
};
```

- [ ] **Step 4: Move Agent tool model selection to `AgentManager`**

In `src/index.ts`:

- Stop resolving `resolvedConfig.modelInput` into `ctx.modelRegistry` in the Agent tool.
- Pass `requestedModel: resolvedConfig.modelFromParams ? resolvedConfig.modelInput : undefined`.
- If a custom agent config supplies a model and there is no explicit model, resolve it only as `options.model` fallback for no-policy compatibility.
- Use the manager-selected model for `AgentDetails.modelName` and invocation display. If necessary, expose the selected model on the created `AgentRecord` instead of recomputing before spawn.

- [ ] **Step 5: Remove the embedded Anthropic Explore pin**

Delete this field from `src/default-agents.ts`:

```ts
model: "anthropic/claude-haiku-4-5",
```

Update its comment to state that the parent model is the generic default and host integrations may supply policy through the runtime hook.

- [ ] **Step 6: Route schedule and RPC model text unchanged**

In `src/schedule.ts`, remove fire-time `resolveModel()` and call:

```ts
manager.spawn(pi, ctx, job.subagent_type, job.prompt, {
  requestedModel: job.model,
  description: job.description,
  isBackground: true,
  bypassQueue: true,
  // existing options
});
```

In `src/cross-extension-rpc.ts`, remove its model-string resolution branch and normalize only:

```ts
const normalizedOptions = {
  ...(options ?? {}),
  ...(typeof options?.model === "string" ? { requestedModel: options.model, model: undefined } : {}),
};
```

Retain support for an already-resolved `options.model` object from internal callers.

- [ ] **Step 7: Run all fork tests and static checks**

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Expected: typecheck/lint/build exit 0 and all Vitest files pass.

- [ ] **Step 8: Commit spawn-path convergence**

```bash
git add src/index.ts src/invocation-config.ts src/default-agents.ts src/schedule.ts src/cross-extension-rpc.ts test/
git commit -m "feat: enforce model policy across subagent spawn paths"
```

---

### Task 3: Build Orchestrel Policies and Safely Remove Legacy Files

**Repository:** `/home/ryan/Code/orchestrel`

**Files:**
- Create: `src/shared/subagent-policy.ts`
- Create: `src/shared/subagent-policy.test.ts`
- Modify: `src/shared/config.ts`
- Modify: `src/orcd/config.ts`

**Interfaces:**
- Produces:

```ts
export interface OrchestrelSubagentPolicy {
  parentProvider: string;
  parentModel: string;
  agents: Record<string, { model: string; source: string }>;
  allowCrossProvider: false;
}

export function buildSubagentPolicy(
  providerId: string,
  parentModelId: string,
  provider: Pick<ProviderDef, "models" | "aliases" | "agents">,
): OrchestrelSubagentPolicy;

export function serializeSubagentPolicy(policy: OrchestrelSubagentPolicy): string;
export function parseSubagentPolicy(value: string): OrchestrelSubagentPolicy;
export function cleanupManagedSubagentFiles(cwd: string): void;
```

- [ ] **Step 1: Write failing policy mapping tests**

Cover exact outcomes:

```ts
it("maps aliases and granular overrides to fully qualified models", () => {
  expect(buildSubagentPolicy("chatgpt", "gpt-5.5", {
    models: {
      main: model("gpt-5.5"),
      mini: model("gpt-5.4-mini"),
      nano: model("gpt-5.4-nano"),
    },
    aliases: { subagent: "mini", lightweight: "nano" },
    agents: { Plan: "main" },
  })).toMatchObject({
    parentProvider: "chatgpt",
    parentModel: "chatgpt/gpt-5.5",
    agents: {
      "general-purpose": { model: "chatgpt/gpt-5.4-mini", source: "subagent tier" },
      Explore: { model: "chatgpt/gpt-5.4-nano", source: "lightweight tier" },
      Plan: { model: "chatgpt/gpt-5.5", source: "agent override" },
    },
  });
});

it("uses positional fallback and parent model for Plan", () => {
  // first=main, second=worker, third=small
  // general-purpose -> worker; Explore -> small; Plan -> parent
});

it("throws for a configured unknown agent model key", () => {
  expect(() => buildSubagentPolicy("trackable", "auto", {
    models: { main: model("auto") },
    agents: { Explore: "missing" },
  })).toThrow('unknown model key "missing" for agent "Explore"');
});
```

Unlike the old synchronizer, unknown configured keys must fail configuration instead of silently selecting the first model.

- [ ] **Step 2: Write failing cleanup tests**

Use a temporary directory and verify:

```ts
it("deletes only Orchestrel-managed agent files and prunes empty directories", () => {
  // managed Explore.md is removed; unmarked Custom.md survives;
  // .pi/settings.json survives; directories are removed only when empty.
});

it("does not create .pi in a clean project", () => {
  cleanupManagedSubagentFiles(dir);
  expect(existsSync(join(dir, ".pi"))).toBe(false);
});
```

These tests are worth retaining because cleanup is destructive filesystem logic and an overly broad deletion would remove user configuration.

- [ ] **Step 3: Run the new test file and confirm RED**

```bash
bun x vitest run src/shared/subagent-policy.test.ts
```

Expected: FAIL because the policy module does not exist.

- [ ] **Step 4: Implement deterministic mapping and serialization**

Implement named agent defaults without copying prompts:

```ts
const DEFAULT_TIERS = {
  "general-purpose": "subagent",
  Explore: "lightweight",
} as const;
```

Map aliases when present; otherwise use model insertion order with second/third fallback. Add `Plan` at the parent model, then apply `agents` overrides last. Validate parse/serialization fields and enforce `allowCrossProvider === false`.

- [ ] **Step 5: Implement marker-only cleanup**

Use `existsSync`, `readdirSync`, `readFileSync`, `rmSync`, and `rmdirSync`. Catch filesystem errors, log one warning, and never fail session creation solely because cleanup cannot write to a project.

- [ ] **Step 6: Run focused and shared config tests**

```bash
bun x vitest run src/shared/subagent-policy.test.ts src/orcd/__tests__/config.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit shared policy construction**

```bash
git add src/shared/subagent-policy.ts src/shared/subagent-policy.test.ts src/shared/config.ts src/orcd/config.ts
git commit -m "feat: build runtime subagent policies"
```

---

### Task 4: Add the Orchestrel-Owned Pi Extension

**Repository:** `/home/ryan/Code/orchestrel`

**Files:**
- Create: `src/pi-extensions/orchestrel-subagent-policy.ts`
- Create: `src/pi-extensions/orchestrel-subagent-policy.test.ts`

**Interfaces:**
- Consumes: `OrchestrelSubagentPolicy` and pi-subagents channel `subagents:model-policy`.
- Produces:

```ts
export const ORCHESTREL_SUBAGENT_POLICY_ENV = "ORCHESTREL_SUBAGENT_POLICY";
export function createOrchestrelSubagentPolicyExtension(
  policy: OrchestrelSubagentPolicy,
): ExtensionFactory;
export default function orchestrelSubagentPolicyFromEnv(pi: ExtensionAPI): void;
```

- [ ] **Step 1: Write failing extension tests using real Pi event buses**

Use `createEventBus()` and a minimal fake `ExtensionAPI` carrying that bus. Test:

```ts
it("returns mapped models and lets explicit same-provider models win", () => {
  const bus = createEventBus();
  loadPolicyFactory(bus, trackablePolicy);

  const mapped = request(bus, { agentType: "Explore", parentProvider: "trackable", parentModel: "trackable/auto" });
  expect(mapped.decision).toEqual({ model: "trackable/claude-opus-4-6", source: "lightweight tier" });

  const explicit = request(bus, { agentType: "Explore", requestedModel: "trackable/auto", parentProvider: "trackable", parentModel: "trackable/auto" });
  expect(explicit.decision).toEqual({ model: "trackable/auto", source: "explicit" });
});

it("rejects explicit and parent providers that do not match policy", () => {
  // Assert descriptive decisions for both mismatch cases.
});

it("keeps two event bus policies independent", () => {
  // Install trackable on bus A and chatgpt on bus B; request Explore from both.
});
```

These tests are worth retaining because event-bus isolation is the concurrency guarantee replacing shared project files.

- [ ] **Step 2: Run extension tests and confirm RED**

```bash
bun x vitest run src/pi-extensions/orchestrel-subagent-policy.test.ts
```

Expected: FAIL because the extension does not exist.

- [ ] **Step 3: Implement the factory and default env entrypoint**

The handler mutates only a request with no existing decision:

```ts
function register(pi: ExtensionAPI, policy: OrchestrelSubagentPolicy) {
  const unsubscribe = pi.events.on("subagents:model-policy", (raw) => {
    const req = validateRequest(raw);
    if (req.decision) return;
    if (req.parentProvider !== policy.parentProvider) {
      req.decision = { error: `Subagent policy provider "${policy.parentProvider}" does not match parent provider "${req.parentProvider}".` };
      return;
    }
    if (req.requestedModel) {
      const provider = req.requestedModel.slice(0, req.requestedModel.indexOf("/"));
      req.decision = provider === policy.parentProvider
        ? { model: req.requestedModel, source: "explicit" }
        : { error: `Subagent model "${req.requestedModel}" is not allowed. This session uses provider "${policy.parentProvider}".` };
      return;
    }
    const mapped = policy.agents[req.agentType];
    req.decision = mapped ?? { model: policy.parentModel, source: "parent model" };
  });
  pi.on("session_shutdown", () => unsubscribe());
}
```

The default export reads and parses `ORCHESTREL_SUBAGENT_POLICY_ENV`; missing or malformed policy throws during extension loading instead of running without enforcement.

- [ ] **Step 4: Run extension and policy tests**

```bash
bun x vitest run src/pi-extensions/orchestrel-subagent-policy.test.ts src/shared/subagent-policy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the extension**

```bash
git add src/pi-extensions/orchestrel-subagent-policy.ts src/pi-extensions/orchestrel-subagent-policy.test.ts
git commit -m "feat: add Orchestrel subagent policy extension"
```

---

### Task 5: Wire Session-Local Policies into orcd

**Repository:** `/home/ryan/Code/orchestrel`

**Files:**
- Modify: `src/orcd/pi-runtime.ts`
- Modify: `src/orcd/__tests__/pi-runtime.test.ts`
- Modify: `src/orcd/__tests__/pi-runtime-bgc.test.ts` only if its SDK mock needs the new loader API

**Interfaces:**
- Consumes: `buildSubagentPolicy()`, `cleanupManagedSubagentFiles()`, and `createOrchestrelSubagentPolicyExtension()`.
- Produces: every `createPiRuntimeSession()` uses its own `EventBus` and `DefaultResourceLoader` containing the policy factory.

- [ ] **Step 1: Extend SDK mocks and write a failing wiring test**

Mock `createEventBus` and `DefaultResourceLoader`. Capture constructor options and assert:

```ts
expect(createEventBus).toHaveBeenCalledTimes(2); // two separate sessions
expect(loaderOptions[0].eventBus).not.toBe(loaderOptions[1].eventBus);
expect(loaderOptions[0].extensionFactories).toHaveLength(1);
expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
  resourceLoader: expect.any(Object),
}));
```

Add a temp-cwd assertion that session creation removes a legacy marked file but does not create `.pi` in a clean cwd.

This test is worth retaining because accidental process-global buses would cause one card's provider policy to affect another card.

- [ ] **Step 2: Run pi-runtime tests and confirm RED**

```bash
bun x vitest run src/orcd/__tests__/pi-runtime.test.ts src/orcd/__tests__/pi-runtime-bgc.test.ts
```

Expected: FAIL because `createPiRuntimeSession()` still calls `syncAgentOverrides()` and uses Pi's implicit resource loader.

- [ ] **Step 3: Construct and reload the session resource loader**

In `createPiRuntimeSession()` after provider registration and before `createAgentSession()`:

```ts
cleanupManagedSubagentFiles(opts.cwd);
const policy = buildSubagentPolicy(providerId, modelId, opts.provider);
const eventBus = createEventBus();
const resourceLoader = new DefaultResourceLoader({
  cwd: opts.cwd,
  agentDir,
  eventBus,
  extensionFactories: [createOrchestrelSubagentPolicyExtension(policy)],
});
await resourceLoader.reload();
```

Pass `resourceLoader` to `createAgentSession()`. Remove `syncAgentOverrides()` entirely. Keep the existing `bindExtensions()` call so `session_start` still initializes all extensions.

- [ ] **Step 4: Add concise policy decision logging**

Have the policy extension optionally accept an `onDecision` callback in its factory options. orcd supplies:

```ts
({ agentType, decision }) => {
  if ("model" in decision) console.log(`[orcd] subagent ${agentType} -> ${decision.model} (${decision.source})`);
}
```

Do not log policy JSON, prompts, or credentials.

- [ ] **Step 5: Run orcd runtime and async lifecycle tests**

```bash
bun x vitest run src/orcd/__tests__/pi-runtime.test.ts src/orcd/__tests__/pi-runtime-bgc.test.ts src/orcd/__tests__/session-async-tasks.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit orcd wiring**

```bash
git add src/orcd/pi-runtime.ts src/orcd/__tests__/pi-runtime.test.ts src/orcd/__tests__/pi-runtime-bgc.test.ts
git commit -m "feat(orcd): inject session-local subagent policy"
```

---

### Task 6: Wire Policy into the `orc` CLI

**Repository:** `/home/ryan/Code/orchestrel`

**Files:**
- Modify: `bin/orc`
- Modify: `bin/orc.test.ts`

**Interfaces:**
- Consumes: `buildSubagentPolicy()`, `serializeSubagentPolicy()`, `cleanupManagedSubagentFiles()`, and `ORCHESTREL_SUBAGENT_POLICY_ENV`.
- Produces: Pi argv includes `-e <absolute-extension-path>`; child env includes serialized policy; `--print-env` reports non-secret policy metadata without mutating the cwd.

- [ ] **Step 1: Write failing stub-process tests**

Extend the existing executable Pi stub to write argv/env to a temp output file. Run `orc` without `--print-env` from a clean temp cwd and assert:

```ts
expect(stub.args).toContain("-e");
expect(stub.args).toContain(resolve(repoRoot, "src/pi-extensions/orchestrel-subagent-policy.ts"));
expect(JSON.parse(stub.env.ORCHESTREL_SUBAGENT_POLICY)).toMatchObject({
  parentProvider: "trackable",
  parentModel: "trackable/auto",
});
expect(existsSync(join(cwd, ".pi"))).toBe(false);
```

Add a second test with a marked legacy file and an unmarked file: marked is removed, unmarked survives.

These tests are worth retaining because argv/env is the real process boundary and `--print-env` tests alone cannot prove the launched Pi receives policy.

- [ ] **Step 2: Run CLI tests and confirm RED**

```bash
bun x vitest run bin/orc.test.ts
```

Expected: FAIL because `orc` still calls `syncAgentOverrides()` and does not load the extension.

- [ ] **Step 3: Build Pi argv and child env with policy**

Resolve the extension path relative to `REPO_ROOT`:

```ts
const SUBAGENT_POLICY_EXTENSION = resolve(REPO_ROOT, "src/pi-extensions/orchestrel-subagent-policy.ts");
const policy = buildSubagentPolicy(resolved.providerId, model.modelID, provider);
const policyJson = serializeSubagentPolicy(policy);
```

Change `buildPiArgs()` so `-e SUBAGENT_POLICY_EXTENSION` is always included before prompt/passthrough args. Add to child env:

```ts
[ORCHESTREL_SUBAGENT_POLICY_ENV]: policyJson,
```

Call `cleanupManagedSubagentFiles(process.cwd())` immediately before `syncModelsJson()` and spawning. Remove `syncAgentOverrides()`.

- [ ] **Step 4: Keep `--print-env` side-effect free**

Do not clean files or write `models.json` in `--print-env` mode. Include only safe diagnostic fields:

```ts
subagentPolicy: {
  parentProvider: policy.parentProvider,
  parentModel: policy.parentModel,
  agents: policy.agents,
},
subagentPolicyExtension: SUBAGENT_POLICY_EXTENSION,
```

No credentials exist in the policy.

- [ ] **Step 5: Run CLI tests and a real `orc` smoke test**

```bash
bun x vitest run bin/orc.test.ts
rm -rf /tmp/orc-policy-smoke
mkdir -p /tmp/orc-policy-smoke
cd /tmp/orc-policy-smoke
echo "hello world" > greeting.txt
timeout 180 /home/ryan/Code/orchestrel/bin/orc -p \
  "Use the Agent tool to spawn Explore and find the file containing hello." \
  trackable auto
```

Expected:

- Tests pass.
- Agent result identifies `greeting.txt`.
- Agent details show the configured trackable lightweight-tier model.
- `/tmp/orc-policy-smoke/.pi` does not exist.

- [ ] **Step 6: Commit CLI wiring**

```bash
git add bin/orc bin/orc.test.ts
git commit -m "feat(orc): inject runtime subagent policy"
```

---

### Task 7: Remove Generated-Agent Infrastructure and Verify Both Repositories

**Repositories:** `/home/ryan/Code/orchestrel` and `/home/ryan/Code/pi-subagents`

**Files:**
- Delete: `src/orcd/subagent-agents.ts`
- Delete: `src/orcd/__tests__/subagent-agents.test.ts`
- Modify: `src/shared/config.ts`
- Modify: `src/orcd/config.ts`
- Modify: comments/imports found by repository-wide search
- Verify: approved design and implementation docs remain accurate

**Interfaces:**
- Consumes: all runtime policy wiring from Tasks 1–6.
- Produces: no production reference to generated `.pi/agents` files except marker-only legacy cleanup.

- [ ] **Step 1: Prove all old synchronizer references are gone**

Run:

```bash
cd /home/ryan/Code/orchestrel
rg -n "syncAgentOverrides|effectiveAgentModels|resolveTierModelId|AGENT_TEMPLATES|subagent-agents"
```

Expected before deletion: only the old module/tests and stale comments/imports remain. If a runtime caller remains, migrate it before continuing.

- [ ] **Step 2: Delete old module/tests and update types/comments**

Move `ProviderAliases` to `src/shared/subagent-policy.ts` or use `ProviderDef["aliases"]` directly. Update comments to say aliases feed runtime policy rather than project frontmatter. Delete the old module and its tests.

- [ ] **Step 3: Verify only safe cleanup mentions `.pi/agents`**

```bash
rg -n "\.pi/agents|managed_by: orchestrel" src bin
```

Expected: matches only in `cleanupManagedSubagentFiles()`, its tests, and explanatory migration comments. No write path remains.

- [ ] **Step 4: Run full Orchestrel verification**

```bash
bun run lint
bun run typecheck
bun run test
bun run build
git diff --check
```

Expected: every command exits 0. The known Vite sourcemap warning may print, but build must succeed.

- [ ] **Step 5: Run full pi-subagents verification**

```bash
cd /home/ryan/Code/pi-subagents
npm run lint
npm run typecheck
npm run test
npm run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 6: Run a two-policy isolation component test**

Create two in-memory Pi resource loaders/event buses in the Orchestrel test suite, one trackable and one chatgpt. Issue model-policy requests concurrently with `Promise.all()` and assert each receives only its own provider's model. This is component-level rather than a live API call, making it deterministic while exercising the real event bus and extension factory.

- [ ] **Step 7: Commit removal and final verification updates**

```bash
cd /home/ryan/Code/orchestrel
git add -A src/orcd/subagent-agents.ts src/orcd/__tests__/subagent-agents.test.ts src/shared/config.ts src/orcd/config.ts src/shared/subagent-policy.ts src/pi-extensions
git commit -m "refactor: remove generated subagent files"
```

- [ ] **Step 8: Record durable architecture memory**

Store the final contract, channel name, precedence, loader isolation, CLI env variable, and cleanup behavior in shared memory. Update the old managed-agent-file memory rather than leaving it stale.

- [ ] **Step 9: Leave services untouched**

Confirm service start timestamps are unchanged:

```bash
systemctl show orcd -p ActiveEnterTimestamp --value
systemctl show orchestrel -p ActiveEnterTimestamp --value
```

Do not restart either service. Report that backend changes require a later explicitly authorized orcd restart to activate.
