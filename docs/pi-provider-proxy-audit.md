# Pi Provider/Proxy Simplification Audit

## Current Orchestrel responsibilities

Current responsibilities in Orchestrel today:

- UI provider/model aliases and labels from `config.yaml` (`src/shared/config.ts`, `src/server/config/providers.ts`).
- Card provider/model persistence and project defaults (`src/server/models/Card.ts`, `src/server/models/Project.ts`).
- Context window display metadata (`contextWindow`) used for card gauges and tracking (`src/server/models/Card.ts`, `src/server/controllers/card-sessions.ts`).
- Provider credential/env routing metadata (`baseUrl`, `apiKey`, `authToken`, Bedrock `region`/`profile`) carried through config parsing (`src/shared/config.ts`, `src/orcd/config.ts`, `config.example.yaml`).
- Proxy selection for account pools by choosing provider entries that point at proxy/KPP base URLs.

Inventory highlights from required search terms (`ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|baseUrl|authToken|KPP|proxy|openai|anthropic`):

- Current branch docs/config still reference provider/proxy fields (`baseUrl`, `authToken`, anthropic, proxy) in `README.md` and `config.example.yaml`.
- `src/orcd/pi-runtime.ts` now uses Pi SDK `AuthStorage` + `ModelRegistry` + `createAgentSession` directly, so Claude env var routing is not the primary runtime path for session creation anymore.
- `src/shared/config.ts` still builds `ANTHROPIC_DEFAULT_*` alias env values for compatibility.
- `src/orcd/pi-provider.ts` currently appears unused in runtime flow (only referenced by its tests).

## Responsibilities Pi can own

Responsibilities Pi can own (or already owns in the runtime path):

- Native Anthropic calls.
- OpenAI-format calls where Pi provider integrations support them.
- Model auth storage where Pi supports it (Pi auth storage / runtime auth layers).
- MCP and extension integration where Pi supports it.

## Keep in Orchestrel

Keep these in Orchestrel:

- Per-card provider/model selection.
- Provider/model labels for UI presentation.
- Context-window metadata for context tracking and display.
- Project defaults for provider/model/thinking behavior on new cards.

These are app-level product concerns independent of which SDK/provider runtime executes sessions.

## Remove from Orchestrel runtime

Remove from Orchestrel runtime over time (after real-run validation):

- Claude Code executable path as a runtime dependency for `orcd` session execution.
- Claude Code-specific env names as primary config/runtime wiring.
- Claude JSONL session assumptions as canonical runtime/session state.

Audit conclusion: do not remove KPP/provider concepts yet. Keep them until Pi replacement behavior is verified in real runs across direct provider and proxy/KPP scenarios.

## Open decisions

1. Whether KPP still adds account-pool value beyond Pi provider routing.
2. Whether Bedrock remains first-class in Orchestrel config or moves to Pi config only.
3. Timing/criteria for deleting compatibility env behavior once provider routing parity is proven in production-like runs.
