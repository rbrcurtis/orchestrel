# Sync per-user preferences to remote nodes through card creation

Date: 2026-10-29. Status: implemented on the branch; not deployed.

## Problem

`src/orcd/preferences.ts` reads `data/preferences/<email>.md` from **the node running orcd**.
Three consequences:

1. The files are written by the preference maintainer, which only runs where `maintainers: true`
   is set (the box that owns orchestrel.db, i.e. debian). Remote nodes never receive them; pvp
   only has a stale snapshot copied when the container was built, and cecil has none.
2. There is no distribution mechanism at all, so a remote node's copy can be months old and no one
   notices.
3. Sessions authored over loopback with the API token resolve to `LOCAL_ADMIN`
   (`email: 'local'`, `src/server/services/user.ts:15`) — a human author with no file. Observed
   live on pvp: `[orcd] no preference file for local`, so those cards got no preferences even on
   the node that owns the files.

## Design: ship the file, write it, then read it locally

The backend is the only node that can see every user's file, and it already sends a `create`
action whenever a card starts a session. Carry the acting user's file with that action; the node
writes it to its own `data/preferences/<email>.md` and everything downstream stays exactly as it
is today.

### 1. Backend resolves the file

`src/server/services/user-prefs.ts`:

- `prefEmailFor(identity, defaultUser)` — a human identity's email wins, except the synthetic ones
  (`local`, `system`, `local@orchestrel.local`), which are "no person" and fall through to the
  backend's `defaultUser`. This is what closes gap 3.
- `loadPrefsBody(email, dir)` — reads `<dir>/<email>.md`, trims, `undefined` when missing/blank.
- `prefsForAuthor(author)` → `{ email, body }` or `undefined` when there is no user to attribute
  the sync to. An **empty body is still sent**: it is how a node's stale copy gets cleared.
- Directory from BE config `memory.preferences.dir`, defaulting to `data/preferences`.

### 2. Protocol

`CreateAction` gains:

```ts
preferences?: { email: string; body: string };
```

`WarmAction` and `CompactAction` are untouched — they re-instantiate a session on a node that has
already received the file.

### 3. Node writes, then reads

`src/orcd/preferences.ts`:

- `saveUserPrefs(email, body, dir)` — atomic (write `*.tmp-<pid>`, then rename, so a concurrent
  session cannot read a half-written file), creates the directory on first sync, refuses an email
  that could escape the directory, logs the byte count, and never throws: a failed sync leaves the
  old copy in place and the card still runs.
- `src/orcd/socket-server.ts` `handleCreate` calls it **before** the session is constructed, so the
  first session on a node already sees the backend's copy. Session creation then does the ordinary
  `prefsFor(author)` local read; `warm` and `compact` keep doing the same.

### 4. Lag

The sync is per card creation, so a node's copy can trail the backend's until that user starts
their next card there. Accepted: the alternative was making the body authoritative on every
session action, which would have the node ignore its own file.

Consequence worth owning: an edited preference takes effect on a node at that node's next card for
that user, not immediately.

### 5. Tests

- `src/server/services/user-prefs.test.ts` — synthetic → `defaultUser`, missing/blank file, empty
  body still sent, directory override, path-escaping emails refused.
- `src/orcd/preferences.test.ts` — `saveUserPrefs` writes where `loadUserPrefs` reads, replaces a
  stale copy, creates the directory, clears the file for an empty body, refuses escaping emails.
- Existing argument assertions use `objectContaining`, since the create action now carries the body.

### 6. Rollout

1. Ship the BE (it starts sending `preferences`). An older orcd ignores the unknown field, so
   nothing changes for it: it keeps reading whatever local copy it has.
2. Pull and restart orcd on cecil and pvp (with approval), after which their copies converge on the
   next card per user.

### Out of scope

- Syncing the files themselves, and running maintainers on more than one node.
- Preference writing from remote sessions: the maintainer reads session excerpts from the DB, which
  is also single-node.
