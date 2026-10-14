import { renameSync, writeFileSync } from 'node:fs'

/**
 * Write `content` so a crash mid-write can never leave a partial file: the
 * bytes land in `<path>.tmp` first and are renamed over the target (rename is
 * atomic within a filesystem). A reader therefore sees either the old content
 * or the complete new content, never a truncated file — the failure mode that
 * would otherwise leave a config unparseable, and for bootstrap.json send the
 * next boot down the re-seed path.
 */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}
