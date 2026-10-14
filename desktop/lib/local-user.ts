// The desktop app's single local user — DESKTOP SIDE of a deliberately
// duplicated constant. The desktop tsconfig is composite with rootDir=desktop
// and cannot import from the repo's src/, so the backend keeps its own copy
// at src/shared/desktop-user.ts. Both copies are pinned to the same literal
// by tests on each side (seed.test.ts asserts the orcd.yaml defaultUser;
// src/server/ws/auth.test.ts asserts the resolved loopback identity email),
// so drifting one side fails that side's suite. Keep them equal.
export const DESKTOP_LOCAL_USER = 'local@orchestrel.local'
