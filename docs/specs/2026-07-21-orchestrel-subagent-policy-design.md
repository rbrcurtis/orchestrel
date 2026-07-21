# Orchestrel-Owned Subagent Model Policy

**Date:** 2026-07-21
**Status:** Approved

## Problem

Orchestrel currently selects provider-correct subagent models by writing managed agent definitions into every project under `.pi/agents/*.md`. This has several problems:

- It mutates project directories for runtime configuration.
- It duplicates complete pi-subagents prompts inside Orchestrel because a project agent definition fully replaces the fork's embedded definition.
- Sessions using different providers in the same project can overwrite each other's files.
- Invalid generated frontmatter can prevent the entire pi-subagents extension from loading.
- Runtime provider policy is represented as persistent project state even though it belongs to the current Orchestrel session.

The replacement must support both the Orchestrel application/orcd and the `orc` CLI. Direct, unwrapped Pi is outside this workflow and need not receive Orchestrel provider configuration.

## Ownership

Orchestrel treats provider-correct subagents as a first-class product capability and ships an Orchestrel-owned Pi extension.

### Orchestrel owns

- Agent type to model mapping derived from `orcd.yaml`/`config.yaml`.
- Parent-provider enforcement.
- Explicit subagent model validation policy.
- Delivery of per-session policy to pi-subagents.
- Cleanup of legacy managed project files.

### pi-subagents fork owns

- Agent definitions and prompts.
- Model lookup in Pi's `ModelRegistry`.
- Foreground and background execution.
- Scheduling, steering, worktree isolation, result retrieval, and retries/resume behavior.

Orchestrel will not reimplement the `Agent` tool. The integration is intentionally tight but limited to a small runtime policy contract.

## Architecture

### Orchestrel policy extension

Add an extension in the Orchestrel repository, loaded explicitly by both supported runtimes:

```text
src/pi-extensions/orchestrel-subagent-policy.ts
```

It is not globally installed and is not discovered from project directories. It receives an already-resolved policy such as:

```ts
{
  parentProvider: "trackable",
  parentModel: "trackable/auto",
  agents: {
    "general-purpose": {
      model: "trackable/claude-sonnet-4-6",
      source: "subagent tier"
    },
    Explore: {
      model: "trackable/claude-opus-4-6",
      source: "lightweight tier"
    }
  },
  allowCrossProvider: false
}
```

The extension registers a session-local model-policy resolver over Pi's event bus and unregisters it during session shutdown. It contains no provider-specific branches.

### pi-subagents integration hook

The fork exposes a synchronous policy request at the shared spawn boundary:

```ts
interface SubagentModelRequest {
  agentType: string;
  requestedModel?: string;
  parentProvider: string;
  parentModel: string;
}

interface SubagentModelDecision {
  model?: string;
  error?: string;
}
```

The hook must cover every creation path, not only visible `Agent` tool calls:

- Foreground agents
- Background agents
- Scheduled agents
- Cross-extension RPC agents
- Retries and resumed agents

A resumed agent retains the model selected when its record/session was created.

When no Orchestrel resolver is installed, the fork may retain its normal behavior. Direct Pi is not an Orchestrel-supported provider workflow.

## Model Selection

### Configuration mapping

Orchestrel computes the effective per-agent models from the selected provider:

1. `agents.<agentName>` granular override
2. Semantic tier mapping:
   - `general-purpose` uses `aliases.subagent`
   - `Explore` uses `aliases.lightweight`
   - `Plan` uses the parent model unless explicitly configured
3. Existing positional fallback when aliases are absent:
   - subagent tier uses the second model, falling back to the first
   - lightweight tier uses the third model, falling back to the second/first
4. Parent model when no agent mapping can be resolved

All policy-selected models are fully qualified `provider/modelID` values.

### Invocation precedence

For an `Agent` invocation:

1. An explicit `model` parameter wins if it resolves to the parent provider.
2. Otherwise, use the Orchestrel mapping for the selected agent type.
3. Otherwise, inherit the parent model.

Cross-provider explicit models are rejected before execution. The initial policy is strict because Orchestrel does not currently route parent and child agents across providers. Future exceptions can extend the policy without changing subagent execution machinery.

Example rejection:

```text
Subagent model "anthropic/claude-haiku-4-5" is not allowed.
This session uses provider "trackable".
```

## Runtime Wiring

### orcd

For every Pi session, orcd:

1. Resolves the provider's subagent policy.
2. Creates a session-local Pi event bus.
3. Creates a `DefaultResourceLoader` using that event bus.
4. Adds the Orchestrel policy extension through `extensionFactories`.
5. Supplies the policy directly in memory.
6. Creates and binds the Pi session using that resource loader.

Each session has an independent bus and policy. Cards using different providers can run concurrently in the same daemon without shared mutable state.

### `orc` CLI

For each invocation, `orc`:

1. Resolves the selected provider from `config.yaml`.
2. Builds the same policy as orcd.
3. Serializes the policy into a private process environment variable.
4. Explicitly adds Orchestrel's policy extension to Pi with `-e`.
5. Launches Pi normally.

Each `orc` invocation is a separate process, so process-scoped policy is isolated. The policy environment variable must not contain provider credentials.

## Legacy Cleanup

Both entry points perform safe cleanup before session creation:

- Inspect only `.pi/agents/*.md`.
- Delete files containing `managed_by: orchestrel`.
- Preserve every unmarked file.
- Remove `.pi/agents` if it is empty.
- Remove `.pi` only if it is empty.
- Never create project-level agent files again.

After rollout, remove `syncAgentOverrides()`, `src/orcd/subagent-agents.ts`, and the duplicated full agent prompt templates from Orchestrel.

## Failure Behavior

Subagent launch fails clearly before execution when:

- A configured model key does not exist.
- A fully qualified model cannot be resolved from Pi's registry.
- An explicit model belongs to a different provider.
- The policy resolver returns malformed data.

Configuration errors must not silently fall back to an unrelated model or provider. A missing optional tier may safely inherit the parent model.

Errors should identify the agent type, requested/configured model, parent provider, and same-provider alternatives when useful.

## Observability

The effective model remains visible through pi-subagents' `AgentDetails.modelName` and the Orchestrel subagent UI.

orcd logs one concise launch decision without credentials or full policy JSON:

```text
[orcd:session] subagent Explore -> trackable/claude-opus-4-6 (lightweight tier)
```

The policy does not add model details to the LLM-facing Agent schema unless the caller explicitly uses `model`.

## Verification

### Orchestrel tests

- Alias and positional fallback mapping
- Granular `agents` overrides
- Explicit same-provider model precedence
- Explicit cross-provider rejection
- Independent concurrent event-bus policies
- `orc` extension/policy injection without project writes
- orcd resource-loader policy wiring
- Managed legacy cleanup preserving unmarked files
- No `.pi` files created in a clean project

### pi-subagents fork tests

- Policy application at the shared spawn boundary
- Foreground, background, scheduled, and RPC paths
- Exact policy-selected model resolution
- Policy rejection surfaces as an Agent failure
- No-policy behavior remains valid
- Resumed agents retain their original effective model

### Integration smoke tests

- `orc trackable auto` launches Explore on the configured trackable tier.
- Concurrent orcd sessions using two providers select models independently.
- Cross-provider explicit model is rejected before any API request.
- A clean project remains free of `.pi` files after both `orc` and orcd sessions.

## Rollout

1. Add and verify the pi-subagents policy hook.
2. Add the Orchestrel extension and policy builder.
3. Wire orcd's session-local loader/event bus.
4. Wire `orc` process policy and explicit extension loading.
5. Switch both entry points away from managed agent files.
6. Clean existing managed files safely.
7. Run unit and integration verification.
8. Remove the old synchronizer and duplicated templates.
9. Do not restart services unless explicitly requested.
