# Dispatcher — Implementation Plan

## Phase 1: Project Scaffold

1. Init React Router 7 project with TypeScript, Tailwind CSS
2. Set up tRPC with React Router 7 integration (server-side adapter)
3. Set up SQLite + Drizzle ORM
4. Database schema:
   - `cards` — id, title, description, column, position, priority, repo_id (nullable), pr_url (nullable), session_id (nullable), worktree_path (nullable), worktree_branch (nullable), created_at, updated_at
   - `repos` — id, name, display_name, path, host (github | bitbucket)
5. Seed repo registry: okkanti, trackable, accordyx, veep
6. Dev server binds to 192.168.4.200

## Phase 2: Kanban Board UI

1. Board layout — fixed columns: Backlog, Ready, In Progress, Review, Done
2. Card component — title, repo badge (if linked), priority indicator
3. Drag-and-drop — reorder within columns, move between columns
4. Add card — inline form at top of Backlog column (or quick-add button)
5. Edit/delete card
6. Search bar — filters cards by title and description across all columns
7. Mobile responsive — stacked columns or horizontal scroll on small screens

## Phase 3: Card Detail Panel

1. Slide-out panel (desktop) / full-screen modal (mobile) — same component with responsive sizing
2. Panel content varies by column:
   - **Backlog / Ready:** editable title, description (markdown?), repo selector dropdown, priority
   - **In Progress:** read-only description + Claude session area (if repo linked), otherwise just description
   - **Review:** description + PR link field (URL input, opens in new tab), session output read-only
   - **Done:** description + PR link + session log (read-only, loaded from Claude's native logs)
3. Cards without a repo show description/notes in all states, no session UI

## Phase 4: Worktree Management

1. When a card with a repo moves to In Progress, create a git worktree:
   - Branch name derived from card (e.g., `dispatch/card-{id}-{slug}`)
   - Worktree path: `{repo_path}/.worktrees/dispatch-{card_id}` or similar
   - Store worktree path and branch on card record
2. Claude Code spawns into the worktree path as cwd
3. When card moves to Done, prompt to clean up worktree (or auto-cleanup)
4. Handle edge cases: worktree already exists, repo has uncommitted changes on main

## Phase 5: Claude Code Integration

1. Subprocess manager — spawn, track, kill Claude Code processes
2. Spawn `claude` CLI with flags:
   - `-p --output-format=stream-json --input-format=stream-json` (Claude Code CLI flags for subprocess stdio protocol — newline-delimited JSON over stdin/stdout)
   - `--permission-prompt-tool=stdio --permission-mode=bypassPermissions`
   - `--verbose`
   - cwd = card's worktree path
3. Claude subprocess stdio protocol handler (server-side):
   - Read child process stdout line-by-line, parse newline-delimited JSON messages
   - Handle `control_request` messages (auto-approve all `can_use_tool`)
   - Send `control_response` back via child process stdin
   - Send `initialize` and `set_permission_mode` on startup
4. tRPC subscription (WebSocket/SSE, separate from Claude's stdio protocol) to re-emit parsed Claude output to the browser client
5. Send follow-up user messages to active session via stdin
6. Track session ID from Claude's output for log file reference
7. Handle session completion, errors, process exit

## Phase 6: Session UI

1. Terminal-like output display in card detail panel (In Progress state)
2. Render Claude's streaming messages:
   - Assistant text (markdown rendered)
   - Tool use blocks (collapsible, show tool name + input/output)
   - Error messages
3. Input box at bottom to send follow-up messages
4. Session status indicator (running, completed, errored)
5. For Review/Done: load session log from Claude's native log files by session ID (read-only)

## Phase 7: Polish & Ship

1. Repo management UI — add/edit/remove repos (simple settings page or inline)
2. Card labels/tags
3. Priority sorting within columns
4. Keyboard shortcuts (n = new card, / = search, esc = close panel)
5. Loading states, error boundaries, empty states
6. systemd service file for running in production
7. Bind to 192.168.4.200 in production config

## Future (Not In Scope Now)

- **OpenClaw API:** POST endpoint to request session start/continue, appears as pending card needing approval
- **Sub-tasks** within cards
- **Cost tracking** per Claude session
- **Slash command picker** in session UI
- **Model/agent selection** per session
- **PR status fetching** (GitHub API / Bitbucket API)
