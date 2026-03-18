import { createOpencodeClient } from '@opencode-ai/sdk/v2'

const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4097)
const HEALTH_POLL_MS = 500
const HEALTH_TIMEOUT_MS = 60_000

export class OpenCodeServer {
  client: ReturnType<typeof createOpencodeClient> | null = null

  async start(): Promise<void> {
    const client = createOpencodeClient({ baseUrl: `http://localhost:${OPENCODE_PORT}` })

    const start = Date.now()
    while (Date.now() - start < HEALTH_TIMEOUT_MS) {
      try {
        const res = await fetch(`http://localhost:${OPENCODE_PORT}/api/health`)
        if (res.ok) {
          console.log(`[opencode] server healthy on port ${OPENCODE_PORT}`)
          this.client = client
          return
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
    }
    throw new Error(`[opencode] server did not become healthy within ${HEALTH_TIMEOUT_MS}ms`)
  }

  stop(): void {
    this.client = null
  }
}

export const openCodeServer = new OpenCodeServer()
