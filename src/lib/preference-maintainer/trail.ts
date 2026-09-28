/* Per-run review trail for the preference maintainer. The maintainer writes
 * to the live preference memory; this local JSON dump of the before/after
 * canonical body and the ops lets a human review what changed without reading
 * the memory server. Files go under the system temp dir. */
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export const TRAIL_DIR = join(tmpdir(), 'orchestrel-preferences');

export function writeTrail(data: { userId: number; [k: string]: unknown }): string {
  mkdirSync(TRAIL_DIR, { recursive: true });
  const file = join(TRAIL_DIR, `${data.userId}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}
