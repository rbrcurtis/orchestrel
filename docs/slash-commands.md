# Slash commands

Two independent kinds of slash commands, expanded at different layers.

## Skill / prompt commands

`/merge`, `/qa`, and any other Pi skill or prompt template. Expanded by orcd in `src/orcd/inline-commands.ts`, anywhere in the message, before the model sees the text.

## App commands

`/done`, `/archive`, `/sleep`. Addressed to Orchestrel, never to the model.

Parsed by `parseAppCommands` (`src/shared/slash-commands.ts`) inside `submitCardPrompt`, so it works for both the ws `agent:send` and the REST prompt endpoints: the command is stripped, the remaining text is sent as the prompt, then the card moves through `cardService.updateCard` — the same path as a drag, so a mid-turn move keeps the session alive and the card parks in done/archive when the session exits.

- A command-only message moves the card without prompting.
- `/done` appends at the end of the done column (position-sorted).
- If several appear, the last one wins.
- App commands take precedence over a same-named skill or prompt.

## `/sleep <phrase>`

`/sleep 12 hours`, `/sleep until tuesday at 5pm`. Parks the card in `ready` with `cards.sleep_until` set and never prompts — a sleeping card must not run now.

What follows `then` is kept as `cards.sleep_prompt` and sent when the time arrives, so `/sleep 2 hours then check the deploy` resumes the card with that prompt (`splitSleepArgument`; a prompt on the following lines works too, since `parseAppCommands` ends the phrase at the newline).

`services/sleep.ts` resolves the phrase in four steps, and every epoch comes from GNU `date -d` on this host, never from model arithmetic:

1. **Bare durations** (`45 minutes`, `1.5 hours`, `2 days`, also `in 2 days`) are exact arithmetic.
2. **Calendar boundaries** (`end of the month`, `by the end of next week`) are the first instant after the period, composed from `date +%Y-%m-01` and friends — the model answered 2026-10-31 for `end of the month` on Sep 25 even with the date in its prompt.
3. **`normalizePhrase`** strips filler (`at`, `on`, `until`, `in`, `this`), maps day periods to clock times (morning 09:00, noon 12:00, afternoon 15:00, evening 19:00, night 21:00), falls back to the precise part of a phrase `date` cannot read whole — a clock time or weekday only, never a relative offset, or `end of next month` would resolve to the 25th (`later tonight` → `later 21:00` → `21:00`), and hands phrases that name a day or clock time straight to `date`. This is why `next friday at 10am` and `until tuesday at 5pm` resolve in ~5 ms with no model call, since a small model answers that weekday arithmetic with the wrong day.
4. **Anything left** goes to the `sleepResolver` model in `orcd.yaml`, which only *names* the time (`WAIT: +12 hours` or `WAKE: 2026-09-29 17:00`), with a weekday cross-check and one corrective retry before refusing. `sleepResolver` names a `provider` + `model` pair from the same file, so the API url and key come from the provider entry.

A phrase that names today and has passed (`this morning` at noon) is refused with "has already passed" instead of rolling to tomorrow — `NAMES_TODAY_RE` blocks the roll for `this`/`today`, so `until this afternoon` resolves to today 15:00 locally.

A failed phrase leaves the card alone and posts an error line — unless the resolver model itself is unreachable (gateway down), which is infrastructure and not the user's mistake: the message then goes through as an ordinary prompt, command and all, so orcd unpacks the stored `/sleep` prompt (`~/.pi/agent/prompts/sleep.md`) and injects it. The session's own model then computes the interval and does the wait with Bash, exactly as every `/sleep` worked before this app command existed.

`startSleepWaker` polls every minute: a due card with a stored prompt is woken through `submitCardPrompt` (the same path as a typed prompt, so auto-start skips its own create), and a due card without one just moves to `running`, which auto-starts it via `board:changed`. A card can therefore come out up to a minute late; the first pass runs 3 s after boot, so a wake time that passed while the server was down fires then. The schedule is cleared before the prompt is sent, so a wake prompt that fails reports the error instead of retrying every tick. Moving a sleeping card out of `ready` by hand clears the pending wake and its prompt, and so does an explicit prompt (a prompt means "run now", so it outranks the sleep) — but a prompt that cannot start a session restores the wake time instead of dropping it.
