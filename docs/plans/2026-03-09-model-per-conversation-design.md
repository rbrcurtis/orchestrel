# Model Per Conversation Design

**Date:** 2026-03-09

## Overview

Allow users to configure the Claude model and thinking level per card (conversation), with a project-level required default that new cards inherit. Existing data backfills to `sonnet` / `high`.

## Data Layer

### `projects` table additions
- `defaultModel` — text enum `'sonnet' | 'opus'`, NOT NULL, default `'sonnet'`
- `defaultThinkingLevel` — text enum `'off' | 'low' | 'medium' | 'high'`, NOT NULL, default `'high'`

### `cards` table additions
- `model` — text enum `'sonnet' | 'opus'`, NOT NULL, default `'sonnet'`
- `thinkingLevel` — text enum `'off' | 'low' | 'medium' | 'high'`, NOT NULL, default `'high'`

### Migration
SQLite column defaults handle new rows automatically via `db:push`. Existing rows backfill to `sonnet` / `high` via a data migration script or `db:push` default.

## Thinking Level → SDK Mapping

| Selector | `thinking` | `effort` |
|---|---|---|
| `off` | `{ type: 'disabled' }` | `'low'` |
| `low` | `{ type: 'adaptive' }` | `'low'` |
| `medium` | `{ type: 'adaptive' }` | `'medium'` |
| `high` | `{ type: 'adaptive' }` | `'high'` |

## Backend

### `protocol.ts` — `ClaudeSession`
- Constructor accepts `model: 'sonnet' | 'opus'` and `thinkingLevel: 'off' | 'low' | 'medium' | 'high'`
- `runQuery()` maps them to SDK options:
  - `model`: `'claude-sonnet-4-6'` or `'claude-opus-4-6'`
  - `thinking`: `{ type: 'disabled' }` if `off`, else `{ type: 'adaptive' }`
  - `effort`: `thinkingLevel === 'off' ? 'low' : thinkingLevel`

### `manager.ts` — `SessionManager.create()`
- Accepts `model` and `thinkingLevel`, passes through to `ClaudeSession`

### `cards` router
- `create` mutation: copies `model`/`thinkingLevel` from the linked project's defaults
- `update` mutation: allows overriding `model` and `thinkingLevel` on any card
- `startSession` procedure: passes card's current `model`/`thinkingLevel` to `sessionManager.create()`

### `projects` router
- `create`/`update` mutations: include `defaultModel` and `defaultThinkingLevel` as required fields

## UI

### Project settings form
- Add two required selectors: **Model** (Sonnet / Opus) and **Thinking** (Off / Low / Medium / High)

### Session controls component (stop button / status area in `SessionView.tsx`)
- Add model selector and thinking level selector inline with the stop button and status indicator
- Controls are always editable — changes take effect on the next turn, not mid-turn
- On change: fire card `update` mutation to persist new values to DB

### New card form
- Model and thinking pre-populated from project defaults, editable before creation
