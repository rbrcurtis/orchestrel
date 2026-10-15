# Settings: provider editing

**Status:** implemented 2026-10-15. Mockup: `mocks.rbrcurtis.com/orchestrel-settings-providers/`.

## Problem

Providers live in `orcd.yaml` on each node. Until now the only way to change them
was to hand-edit that file: the desktop app seeds `providers: {}`, so a fresh
install has an empty model dropdown and no way to fill it. The board already
reads providers at run time — orcd advertises `capabilities` (providers +
defaults) over its socket, the backend caches them on the `OrcdClient`, and
every provider dropdown in the UI is built from that — so only the *writing*
half was missing.

## Ownership

**orcd owns its config file.** The backend never learns a node's filesystem
paths, and the same code path works for a remote node: the backend forwards the
edit, the node writes the file it was started with (`ORC_CONFIG`, else
`./config.yaml`) and re-advertises.

Three consequences worth stating:

- `config.yaml` is a **symlink** to `orcd.yaml` on some boxes. Writes resolve
  the real path first, so an atomic tmp+rename replaces the target rather than
  the symlink.
- Writes preserve **file mode 0600** (the file holds API keys) and the rest of
  the document — the file is edited as a YAML document, so comments and
  unmanaged keys survive.
- The values round-trip **unresolved**. `providers_get` returns the raw YAML
  subtree, not the parsed config, so `${ANTHROPIC_API_KEY}` stays a template
  instead of being written back as plaintext.

## Protocol

Three node actions (`src/shared/orcd-protocol.ts`), all admin-gated at the
backend:

| Action | Reply | Purpose |
| --- | --- | --- |
| `providers_get` | `providers` | raw providers + defaults + config path |
| `providers_save` | `capabilities` | validate, write, rebuild in-memory providers, re-advertise |
| `provider_test` | `provider_test` | provider-agnostic reachability probe of `baseUrl` |

After a successful save the backend caches the fresh capabilities and pushes
`nodes:updated` to every client, so open boards pick up new providers without a
reload.

## Validation

orcd validates the merged document before writing anything: provider ids,
per-provider model lists, `defaultProvider`/`defaultModel` resolution,
`baseUrl` for non-OAuth providers, and subagent tier references. The whole
document then goes through the same `parseConfig()` the runtime uses, so a file
that saves is a file that loads. A rejection writes nothing and returns the
problem to the UI.

`provider_test` deliberately does **not** speak any provider's API — orcd has no
provider-specific code. It opens `baseUrl` and treats any HTTP status as
reachable, reporting refusals and DNS failures as unreachable. That is the
failure that actually happens (a local proxy is not running).

## UI

`SettingsModal` is a holy-grail frame: header (title, node chip, unsaved state),
left rail (Providers · Projects · Node · Storage), main pane, right aside, and a
footer that owns save/discard.

The aside shows **live capabilities vs the draft**: what the node currently
advertises (read from the node, not from the draft — with a stale marker while a
draft exists), and, only when dirty, what the board's dropdown gains and loses on
save (`+ anthropic — new in the dropdown`). The two sides are compared on
provider ids and model aliases only (`diffCapabilities`), because a node's
capabilities and the raw file describe a provider differently. An earlier version
of this pane re-rendered the draft as a pseudo-dropdown, which just repeated the
main pane and mislabelled itself.

Secrets stay server-side except for admins: reading raw provider defs (which
include keys) requires role `admin`, and the password-style input only reveals
on demand.

## Out of scope

- Editing a **remote** node's providers from a browser session. The protocol
  supports it (the request carries `nodeName`); the UI only offers it for
  connected nodes and does not yet distinguish them.
- Provider-specific probes (real inference calls) and Pi-side auth/OAuth
  completion — both need provider-specific knowledge that orcd does not have.
- Per-model `thinkingLevel` / `summarizeThreshold` inputs: the form preserves
  those keys verbatim but does not expose them yet.
