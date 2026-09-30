const loadedAt = performance.now();
let last = loadedAt;

/**
 * Log one startup step with the time since the previous step.
 *
 * Startup time is dominated by module loading, so a plain elapsed value is not enough —
 * the deltas show which phase actually cost the seconds. Process uptime is printed too,
 * because everything before the first mark (node boot, tsx transpile) is invisible to
 * timers inside the app.
 */
export function startupMark(label: string): void {
  const now = performance.now();
  console.log(
    `[startup] ${label}: ${(now - last).toFixed(0)} ms since previous, ` +
      `${(now - loadedAt).toFixed(0)} ms since first mark, ${(process.uptime() * 1000).toFixed(0)} ms process uptime`,
  );
  last = now;
}
