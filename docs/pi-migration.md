# Pi Migration Resource Model

Orchestrel is now Pi-native at the agent runtime boundary. The web app and `orcd` still use Orchestrel's own socket protocol for cards, streams, lifecycle, compaction, and memory upsert, but the underlying agent runtime and resource model are Pi resources.

## Current Resource Ownership

- `bin/orc` wraps the `pi` CLI. It resolves Orchestrel provider/model defaults from `config.yaml` and then starts Pi.
- `orcd` embeds the Pi TypeScript SDK (`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`). It creates Pi sessions, subscribes to Pi events, and maps those events into Orchestrel's existing app protocol.
- User-level runtime resources live in Pi's canonical user config directory (`~/.pi`). The current SDK uses `~/.pi/agent` for agent auth/model/session data returned by Pi's `getAgentDir()` helper.
- Project instructions are `AGENTS.md` files in the project tree, resolved by Pi.
- Slash commands are Pi prompt templates / commands.
- Skills are Pi skills. They remain distinct from slash commands and should not be treated as command replacements.

## What Orchestrel No Longer Reads

Orchestrel should not depend on Claude Code resource directories or session files as runtime contracts. Do not rely on any of these for current behavior:

- `~/.claude/CLAUDE.md` for project or user instructions.
- `.claude/commands` for slash commands.
- `.claude/skills` for skills.
- Claude Code JSONL sessions under `~/.claude/projects` for session history, compaction, reload, async task tracking, or memory upsert.

Historical notes and tests may mention old Claude paths as negative examples or legacy fixtures, but production docs and runtime behavior should describe Pi resources as canonical.

## Where To Put Resources Now

Use Pi's native locations and resource types:

| Resource | Current location/model |
| --- | --- |
| User auth and model registry | Pi canonical user config directory (`~/.pi`, currently `~/.pi/agent` through the SDK) |
| Project instructions | `AGENTS.md` in the project tree |
| Slash commands | Pi prompt templates / commands |
| Skills | Pi skills, separate from commands |
| Session history | Pi session storage accessed through Pi session-manager APIs |

## Provider Configuration Boundary

`config.yaml` remains an Orchestrel file. It is used by the web app, `orcd`, and `bin/orc` for provider IDs, model aliases, labels, and context-window metadata. Keep the existing schema unless the implementation changes it.

The important boundary is:

- Orchestrel owns card/project defaults, UI labels, provider/model aliases, context-window metadata, and the daemon socket path.
- Pi owns user-level runtime resources, prompt templates/commands, skills, project instruction discovery, auth/model registry details, and session storage.

When updating docs or implementation, avoid reintroducing Claude Code compatibility paths as current behavior. If an old path appears in a migration note, make it explicit that it is historical or a thing not to rely on.
