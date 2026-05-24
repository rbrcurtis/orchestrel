# bwrap Worktree Sandbox Design

## Goal

Prevent sandbox-enabled agent sessions from editing the root project checkout while preserving the speed and workflow of Git worktrees.

The motivating failure is qwen/mlx agents launched in a worktree issuing absolute commands such as:

```bash
cd /home/ryan/Code/foo && git add -A
```

Today that escapes the worktree and operates on the root checkout. With this design, that same path inside the sandbox resolves to the card's worktree.

## Scope

This design covers filesystem isolation only. It does not attempt network isolation, resource limits, or secret isolation beyond avoiding accidental mounts of the root working tree. The Max/MLX host remains an inference API only; the agent process and filesystem tools run on the Orchestrel host.

## Product model

Sandboxing is a first-class setting parallel to worktrees:

- `projects.default_sandbox` boolean, default `false`.
- `cards.sandbox` boolean, inherited from the project when creating a worktree card/session.
- The UI shows a **Use sandbox** checkbox only when worktree mode is enabled.
- Sandbox is ignored or prevented when the card does not use a worktree.

Effective behavior:

| Worktree | Sandbox | Behavior |
|---|---|---|
| off | off | Current root-checkout behavior |
| off | on | Invalid/ignored; UI should prevent this |
| on | off | Current worktree behavior |
| on | on | bwrap filesystem isolation |

## Launch architecture

The server must pass orcd enough information to distinguish:

- host worktree cwd
- canonical project path
- sandbox enabled

For a sandboxed worktree session:

```text
hostWorktreePath = /home/ryan/Code/foo/.worktrees/card-123
projectPath      = /home/ryan/Code/foo
sandbox          = true
```

orcd launches the Agent SDK through a bwrap wrapper. The SDK option `cwd` should be the canonical project path as seen inside the sandbox:

```text
/home/ryan/Code/foo
```

Inside bwrap, that path is bound to the host worktree path. The real root working tree is not mounted.

## Mount layout

For project `/home/ryan/Code/foo` and worktree `/home/ryan/Code/foo/.worktrees/card-123`, the sandbox should expose:

```text
/home/ryan/Code/foo              -> host worktree path, read-write
/home/ryan/Code/foo/.git-parent  -> host /home/ryan/Code/foo/.git, read-write
/home/ryan/Code/foo/.git         -> synthetic gitdir pointer file
/home/ryan/.claude               -> host /home/ryan/.claude, read-write
/home/ryan/.claude.json          -> host /home/ryan/.claude.json, read-write initially
```

The synthetic `.git` file points Git at the mounted shared metadata:

```text
gitdir: /home/ryan/Code/foo/.git-parent/worktrees/card-123
```

This keeps normal Git worktree operations working while preventing source-file edits in the root checkout.

Mount ordering matters:

1. Create the parent home/code directories inside the namespace.
2. Bind the worktree to the canonical project path.
3. Bind the root repo `.git` directory to `.git-parent` inside the mounted worktree.
4. Overlay the synthetic `.git` file onto the worktree `.git` path.
5. Set cwd to the canonical project path.

## HOME and Claude state

For fastest setup, bind real Claude state directly:

```text
/home/ryan/.claude
/home/ryan/.claude.json
```

Do not bind `/home/ryan` or `/home/ryan/Code` wholesale. Create only the directories needed for the canonical project path, then bind the worktree there.

This intentionally prioritizes compatibility with the existing Claude Code setup. It does not try to isolate Claude's own config/state in this first version.

## Git metadata tradeoff

The root repo `.git` directory is mounted read-write. This is acceptable for the first version because Git worktrees already share metadata and the immediate goal is preventing root working tree file edits.

Consequences:

- Normal Git operations such as commit, fetch, branch, and push should work.
- The root checkout's source files remain hidden from the sandbox.
- Destructive Git metadata commands could still affect shared repo metadata.

If needed later, add command guardrails or selective `.git` mounts. Do not add that complexity to the first version.

## Data flow

1. User creates or runs a worktree card with **Use sandbox** enabled.
2. Server ensures the worktree exists using the current fast worktree flow.
3. Server starts the orcd session with:
   - host worktree path
   - canonical project path
   - sandbox flag
4. orcd builds a per-session bwrap staging directory containing the synthetic `.git` pointer file.
5. orcd launches Claude via the bwrap wrapper.
6. Agent sees `/home/ryan/Code/foo` as its cwd.
7. Source edits go to the host worktree.
8. Absolute commands targeting `/home/ryan/Code/foo` still hit the worktree.
9. On session exit, normal worktree review/PR/cleanup flows continue.

## Error handling

If sandbox setup fails, the session should fail closed rather than silently launching unsandboxed. The user should see a clear error such as:

```text
Sandbox setup failed for card 123: <reason>
```

Expected failure cases:

- `bwrap` is not installed.
- The card has sandbox enabled without a worktree.
- The project path or worktree path does not exist.
- The worktree `.git` pointer does not reference a Git worktree under the project `.git` directory.
- The synthetic `.git` file cannot be created.
- Required Claude config paths are missing or cannot be mounted.

The implementation should validate paths with realpath checks before building the bwrap command:

- worktree path must be inside the project's `.worktrees` directory
- project `.git` path must be a directory
- synthetic `.git` target must point under `.git-parent/worktrees/<worktree-name>` inside the sandbox

## Testing strategy

Unit tests:

- project/card sandbox defaults and inheritance
- sandbox ignored/prevented without worktree
- bwrap argument construction for a normal worktree
- synthetic `.git` pointer content
- path validation rejects non-worktree paths
- orcd passes canonical cwd to the SDK for sandboxed sessions
- unsandboxed sessions keep current cwd behavior

Integration/manual test:

1. Create a worktree card with sandbox enabled.
2. Launch an agent command that runs:

   ```bash
   pwd
   git status
   cd /home/ryan/Code/foo && touch sandbox-proof.txt
   ```

3. Verify `sandbox-proof.txt` appears in the worktree.
4. Verify `sandbox-proof.txt` does not appear in the root checkout.
5. Verify `git status` works inside the sandbox.
6. Verify normal unsandboxed worktree cards still behave as before.

## Non-goals

- Network sandboxing.
- Per-session Claude home isolation.
- Replacing worktrees with clones.
- Protecting shared `.git` metadata from all possible destructive Git commands.
- Containerizing the Max/MLX host.
