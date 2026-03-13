import { WsClient } from '../lib/ws-client'
import { CardStore, setCardStoreWs } from './card-store'
import { ProjectStore, setProjectStoreWs } from './project-store'
import { SessionStore, setSessionStoreWs } from './session-store'
import type { ServerMessage } from '../../src/shared/ws-protocol'

export class RootStore {
  readonly cards: CardStore
  readonly projects: ProjectStore
  readonly sessions: SessionStore
  readonly ws: WsClient

  constructor() {
    this.cards = new CardStore()
    this.projects = new ProjectStore()
    this.sessions = new SessionStore()
    this.ws = new WsClient((msg) => this.handleMessage(msg))

    setCardStoreWs(this.ws)
    setProjectStoreWs(this.ws)
    setSessionStoreWs(this.ws)
  }

  subscribe(columns: string[]) {
    this.ws.subscribe(columns)
  }

  private handleMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'sync':
        this.cards.hydrate(msg.cards)
        this.projects.hydrate(msg.projects)
        break

      case 'card:updated':
        this.cards.handleUpdated(msg.data)
        break

      case 'card:deleted':
        this.cards.handleDeleted(msg.data.id)
        break

      case 'project:updated':
        this.projects.handleUpdated(msg.data)
        break

      case 'project:deleted':
        this.projects.handleDeleted(msg.data.id)
        break

      case 'agent:message':
        this.sessions.ingest(msg.cardId, msg.data)
        break

      case 'agent:status':
        this.sessions.handleAgentStatus(msg.data)
        break

      case 'session:history':
        this.sessions.ingestBatch(msg.cardId, msg.messages)
        break

      // page:result, search:result, project:browse:result — not routed to stores;
      // components that need these should listen directly via WsClient or a separate handler
      case 'page:result':
      case 'search:result':
      case 'project:browse:result':
        // These are request/response patterns handled at the call site via mutate()
        // They arrive as entity messages only if no requestId was tracked (shouldn't happen)
        break

      default: {
        const _exhaust: never = msg
        console.warn('[ws] unhandled message type:', (_exhaust as ServerMessage).type)
      }
    }
  }

  dispose() {
    this.ws.dispose()
  }
}
