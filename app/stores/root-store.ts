import { makeAutoObservable, runInAction } from 'mobx';
import { WsClient } from '../lib/ws-client';
import { CardStore } from './card-store';
import { ConfigStore } from './config-store';
import { ProjectStore } from './project-store';
import { SessionStore } from './session-store';
import type { Card, Column, SyncPayload, User } from '../../src/shared/ws-protocol';

const PROJECT_FILTER_KEY = 'dispatcher-project-filter';

function cardHasVisibleProject(store: RootStore, projectId: number | null): boolean {
  return projectId != null && store.projects.getProject(projectId) != null;
}

function applySync(store: RootStore, data: SyncPayload): void {
  store.currentUser = data.user ?? null;
  store.projects.hydrate(data.projects, true, data.users);
  // Replace only the columns we actually subscribed to. Archive (and any other
  // unsubscribed column) is lazy-paged separately and must survive a sync that
  // resolves after the archive page already merged its cards into the store.
  store.cards.hydrate(
    data.cards.filter((c) => cardHasVisibleProject(store, c.projectId)),
    true,
    store.ws.getSubscribedColumns(),
  );
  store.config.hydrateNodes(data.nodes);
}

/** Read the persisted project filter. Empty set = no filter (show everything). */
function readProjectFilter(): Set<number> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(PROJECT_FILTER_KEY);
    if (!raw) return new Set();
    const ids = JSON.parse(raw) as number[];
    return new Set(ids);
  } catch {
    return new Set();
  }
}

export class RootStore {
  currentUser: User | null = null;
  readonly cards: CardStore;
  readonly config: ConfigStore;
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly ws: WsClient;
  private boardSyncVersion = 0;
  private syncingBoard = false;
  private pendingCardEvents: Array<
    | { type: 'updated'; card: Card }
    | { type: 'deleted'; id: number }
  > = [];

  constructor() {
    this.cards = new CardStore();
    this.config = new ConfigStore();
    this.projects = new ProjectStore();
    this.sessions = new SessionStore();

    this.ws = new WsClient({
      onSync: (data) => applySync(this, data),
      onCardUpdated: (data) => {
        if (this.syncingBoard) {
          this.pendingCardEvents.push({ type: 'updated', card: data });
          return;
        }
        this.handleCardUpdated(data);
      },
      onCardDeleted: (data) => {
        if (this.syncingBoard) {
          this.pendingCardEvents.push({ type: 'deleted', id: data.id });
          return;
        }
        this.cards.handleDeleted(data.id);
      },
      onProjectUpdated: (data) => this.projects.handleUpdated(data),
      onProjectDeleted: (data) => this.projects.handleDeleted(data.id),
      onSessionMessage: (data) => this.sessions.ingestSdkMessage(data.cardId, data.message),
      onAgentStatus: (data) => this.sessions.handleAgentStatus(data),
    });

    makeAutoObservable<this, 'boardSyncVersion' | 'syncingBoard' | 'pendingCardEvents'>(this, {
      ws: false,
      cards: false,
      config: false,
      projects: false,
      sessions: false,
      boardSyncVersion: false,
      syncingBoard: false,
      pendingCardEvents: false,
    });

    this.cards.setWs(this.ws);
    this.projects.setWs(this.ws);
    this.sessions.setWs(this.ws);

    this.ws.onReconnect(async () => {
      const columns = this.ws.getSubscribedColumns();
      if (columns.length > 0) await this.syncBoard(columns);
      await this.sessions.resubscribeAll();
    });

    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  subscribe(columns: string[]) {
    void this.syncBoard(columns as Column[]);
  }

  private async syncBoard(columns: Column[]): Promise<void> {
    const version = ++this.boardSyncVersion;
    this.syncingBoard = true;
    const data = await this.ws.subscribe(columns);
    if (version !== this.boardSyncVersion) return;

    runInAction(() => {
      if (data) applySync(this, data);

      // Room events can arrive before the subscribe snapshot. Replay them after
      // the snapshot so stale query results cannot remove a newly created card.
      const events = this.pendingCardEvents;
      this.pendingCardEvents = [];
      this.syncingBoard = false;
      for (const event of events) {
        if (event.type === 'updated') this.handleCardUpdated(event.card);
        else this.cards.handleDeleted(event.id);
      }
    });
  }

  private handleCardUpdated(data: Card): void {
    if (!cardHasVisibleProject(this, data.projectId)) return;

    const prev = this.cards.getCard(data.id);
    if (
      data.column === 'review' &&
      prev &&
      prev.column !== 'review' &&
      document.visibilityState !== 'visible' &&
      !document.hasFocus() &&
      Notification.permission === 'granted'
    ) {
      const filter = readProjectFilter();
      const filtered = filter.size > 0 && (data.projectId == null || !filter.has(data.projectId));
      if (!filtered) {
        const n = new Notification(data.title, { body: 'moved to review' });
        n.onclick = () => {
          window.focus();
          window.dispatchEvent(new CustomEvent('orchestrel:focus-card', { detail: { cardId: data.id } }));
        };
      }
    }
    this.cards.handleUpdated(data);
  }

  dispose() {
    this.ws.dispose();
  }
}
