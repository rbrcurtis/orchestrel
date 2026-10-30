/**
 * The acting user's preference file, read on the BACKEND so the card's node can
 * write its own copy.
 *
 * The files are written by the preference maintainer, which runs wherever
 * `maintainers: true` is set — the box that owns orchestrel.db, i.e. this one.
 * A remote node therefore has whatever snapshot it happened to be built with.
 * Sending the body with the create action and writing it there is what makes the
 * copies converge; the node then injects preferences the normal local way.
 *
 * Delivery is per card creation, so a node can run one session on a slightly
 * older copy. That lag is accepted: the alternative was shipping the body with
 * every session action and making it authoritative instead of the file.
 */
import { readFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { loadConfig, type OrchestrelConfig } from '../../shared/config';
import { DESKTOP_LOCAL_USER } from '../../shared/desktop-user';
import type { OrcdAuthor } from '../../shared/orcd-protocol';

/**
 * Identities that stand for "no real person in front of it": the synthetic
 * LOCAL_ADMIN a token-authenticated loopback request resolves to (`email:
 * 'local'`), the SYSTEM_AUTHOR the backend uses for autonomous turns, and the
 * desktop app's seeded local user. None of them has a preference file, so they
 * map to the configured defaultUser instead of injecting nothing.
 */
const SYNTHETIC_EMAILS = new Set(['', 'local', 'system', DESKTOP_LOCAL_USER.toLowerCase()]);

export function isSyntheticEmail(email: string | undefined): boolean {
  return email === undefined || SYNTHETIC_EMAILS.has(email.trim().toLowerCase());
}

/** An email is a file name here, so anything that can escape the directory is
 * refused rather than joined. Real identities are CF Access / user-table emails. */
function safeEmail(email: string): string | undefined {
  const trimmed = email.trim();
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(trimmed)) {
    console.warn(`[prefs] ignoring unusable identity ${JSON.stringify(email)} — no credentials for it`);
    return undefined;
  }
  return trimmed;
}

/** Which user's file an acting identity gets: a real email wins, synthetic ones
 * fall back to the backend's defaultUser. */
export function prefEmailFor(author: OrcdAuthor | undefined, defaultUser?: string): string | undefined {
  const email = author?.email;
  if (email && !isSyntheticEmail(email)) {
    console.log(`[prefs] acting user ${email} -> ${email}.md`);
    return safeEmail(email);
  }
  if (defaultUser) {
    console.log(`[prefs] no regular user (${email || 'none'}) -> default ${defaultUser}.md`);
    return safeEmail(defaultUser);
  }
  console.log(`[prefs] no regular user (${email || 'none'}) and no defaultUser; nothing to send`);
  return undefined;
}

/** Preference files live next to the backend's data dir unless config says
 * otherwise (`memory.preferences.dir`). */
export function prefsDir(cfg: OrchestrelConfig = loadConfig()): string {
  const configured = cfg.memory?.preferences?.dir ?? join('data', 'preferences');
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/** Read a user's preference file. Missing or blank = no injection, no error —
 * most users have no file. */
export function loadPrefsBody(email: string, dir: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, `${email}.md`), 'utf8');
  } catch {
    console.log(`[prefs] no preference file for ${email} in ${dir}`);
    return undefined;
  }
  const body = text.trim();
  if (!body) {
    console.log(`[prefs] ${email}'s preference file is empty; sending an empty body`);
    return undefined;
  }
  return body;
}

/** What the node should write for this acting user: which file, and its body.
 *
 * An empty body is meaningful — it tells the node the user genuinely has no
 * preferences, which is how a node's stale copy gets cleared. Only "no user to
 * attribute this to" ships nothing at all.
 */
export interface PrefsPayload {
  email: string;
  body: string;
}

export function prefsForAuthor(author: OrcdAuthor | undefined): PrefsPayload | undefined {
  let cfg: OrchestrelConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    // No config.yaml here (unit tests, a CLI entry point): send nothing rather than
    // guessing, which leaves orcd on its local-file fallback.
    console.warn('[prefs] no backend config, not sending preferences:', err instanceof Error ? err.message : err);
    return undefined;
  }
  const email = prefEmailFor(author, cfg.defaultUser);
  if (!email) {
    console.log('[prefs] no regular user to attribute preferences to; sending nothing');
    return undefined;
  }
  const body = loadPrefsBody(email, prefsDir(cfg)) ?? '';
  console.log(`[prefs] sending ${body.length} chars of ${email} preferences to the card's node`);
  return { email, body };
}
