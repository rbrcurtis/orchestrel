import { EventEmitter } from 'events'
import { watch, openSync, readSync, closeSync, statSync } from 'fs'
import type { FSWatcher } from 'fs'

const STALE_TIMEOUT = 120_000

export class SessionTailer extends EventEmitter {
  private watcher: FSWatcher | null = null
  private offset = 0
  private staleTimer: NodeJS.Timeout | null = null
  private partial = ''

  constructor(
    public readonly filePath: string,
    public readonly cardId: number,
  ) {
    super()
  }

  /** Start tailing from the current end of file (new content only) */
  start(): void {
    try {
      this.offset = statSync(this.filePath).size
    } catch {
      this.offset = 0
    }
    this.resetStaleTimer()
    this.watcher = watch(this.filePath, () => {
      this.readNewLines()
      this.resetStaleTimer()
    })
  }

  private readNewLines(): void {
    try {
      const size = statSync(this.filePath).size
      if (size <= this.offset) return

      const fd = openSync(this.filePath, 'r')
      const len = size - this.offset
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, this.offset)
      closeSync(fd)
      this.offset = size

      const text = this.partial + buf.toString('utf-8')
      const lines = text.split('\n')
      this.partial = lines.pop() ?? ''

      for (const line of lines) {
        if (!line) continue
        try {
          const msg = JSON.parse(line) as Record<string, unknown>
          this.emit('message', msg)
        } catch { /* skip bad lines */ }
      }
    } catch (err) {
      console.error('[SessionTailer] Read error:', err)
    }
  }

  private resetStaleTimer(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer)
    this.staleTimer = setTimeout(() => {
      this.emit('stale')
      this.stop()
    }, STALE_TIMEOUT)
  }

  stop(): void {
    if (this.watcher) { this.watcher.close(); this.watcher = null }
    if (this.staleTimer) { clearTimeout(this.staleTimer); this.staleTimer = null }
    this.partial = ''
    this.removeAllListeners()
  }
}
