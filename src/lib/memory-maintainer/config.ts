/* Memory maintainer routing: resolve a session cwd to a configured memory
 * project by longest prefix match. */
import type { MemoryConfig, MemoryProjectConfig } from '../../shared/config';

export interface RoutedProject {
  key: string;
  cfg: MemoryProjectConfig;
}

export function routeProject(cwd: string, memory: MemoryConfig): RoutedProject | null {
  let bestKey: string | null = null;
  let bestLen = -1;
  for (const [key, cfg] of Object.entries(memory.projects)) {
    for (const prefix of cfg.match) {
      if (cwd.startsWith(prefix) && prefix.length > bestLen) {
        bestKey = key;
        bestLen = prefix.length;
      }
    }
  }
  if (bestKey === null) return null;
  return { key: bestKey, cfg: memory.projects[bestKey] };
}
