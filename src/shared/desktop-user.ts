/**
 * The desktop app's single local user. One email, four roles:
 *  - seeded into `users` as admin by the backend (gate: ORCHESTREL_DESKTOP=1,
 *    see seedLocalUser in src/server/models/index.ts),
 *  - the loopback identity every request acts as on desktop
 *    (resolveIdentity in src/server/ws/auth.ts),
 *  - the backend's sole ADMIN_EMAILS entry (set by desktop/main/main.ts) so
 *    the role recomputation in findOrCreate keeps it admin — a demoted local
 *    user would see zero projects,
 *  - the preference maintainer's `defaultUser` in the seeded orcd.yaml, which
 *    must equal the author email or the session reads a different prefs file
 *    than the maintainer writes.
 *
 * Backend-side copy: the desktop tsconfig is composite (rootDir=desktop) so
 * desktop/ keeps its own duplicate at desktop/lib/local-user.ts; both are
 * pinned to this literal by tests on each side.
 */
export const DESKTOP_LOCAL_USER = 'local@orchestrel.local';
