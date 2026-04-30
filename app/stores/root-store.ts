import { makeAutoObservable, runInAction } from 'mobx';
import { WsClient } from '../lib/ws-client';
import { CardStore } from './card-store';
import { ConfigStore } from './config-store';
import { ProjectStore } from './project-store';
import { SessionStore } from './session-store';
import type { Column, User } from '../../src/shared/ws-protocol';

const PROJECT_FILTER_KEY = 'dispatcher-project-filter';

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

  constructor() {
    this.cards = new CardStore();
    this.config = new ConfigStore();
    this.projects = new ProjectStore();
    this.sessions = new SessionStore();

    this.ws = new WsClient({
      onSync: (data) => {
        this.currentUser = data.user ?? null;
        this.cards.hydrate(data.cards, true);
        this.projects.hydrate(data.projects, true, data.users);
        this.config.hydrate(data.providers);
      },
      onCardUpdated: (data) => {
        const prev = this.cards.getCard(data.id);
        if (
          data.column === 'review' &&
          prev &&
          prev.column !== 'review' &&
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
      },
      onCardDeleted: (data) => this.cards.handleDeleted(data.id),
      onProjectUpdated: (data) => this.projects.handleUpdated(data),
      onProjectDeleted: (data) => this.projects.handleDeleted(data.id),
      onSessionMessage: (data) => this.sessions.ingestSdkMessage(data.cardId, data.message),
      onAgentStatus: (data) => this.sessions.handleAgentStatus(data),
    });

    makeAutoObservable(this, {
      ws: false,
      cards: false,
      config: false,
      projects: false,
      sessions: false,
    });

    this.cards.setWs(this.ws);
    this.projects.setWs(this.ws);
    this.sessions.setWs(this.ws);

    this.ws.onReconnect(() => this.sessions.resubscribeAll());

    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  subscribe(columns: string[]) {
    this.ws.subscribe(columns as Column[]).then((data) => {
      if (!data) return;
      runInAction(() => {
        this.currentUser = data.user ?? null;
        this.cards.hydrate(data.cards, true);
        this.projects.hydrate(data.projects, true, data.users);
        this.config.hydrate(data.providers);
      });
    });
  }

  dispose() {
    this.ws.dispose();
  }
}
