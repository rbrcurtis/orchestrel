import { makeAutoObservable, runInAction } from 'mobx';
import type { WsClient } from '../lib/ws-client';
import { countModels, describeChanges, type RawProvider, type RawProviders } from '../lib/provider-config';
import type { NodeProviderConfig, ProviderTestResult } from '../../src/shared/ws-protocol';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function firstAlias(def: RawProvider | undefined): string {
  return Object.keys((def?.models ?? {}) as Record<string, unknown>)[0] ?? '';
}

/**
 * The working copy of one node's provider config. Edits land here immediately so
 * the whole settings page (list, echo, footer) reads one source; the node only
 * sees them on save(), and the node — not this store — decides whether they are
 * valid, since it owns the file.
 */
export class ProviderConfigStore {
  private ws: WsClient | null = null;

  nodeName = '';
  loadedNode = '';
  configPath = '';
  providers: RawProviders = {};
  savedProviders: RawProviders = {};
  defaultProvider = '';
  defaultModel = '';
  savedDefaults = { provider: '', model: '' };
  loading = false;
  saving = false;
  error: string | null = null;

  constructor() {
    makeAutoObservable<this, 'ws'>(this, { ws: false });
  }

  setWs(ws: WsClient): void {
    this.ws = ws;
  }

  get entries(): Array<[string, RawProvider]> {
    return Object.entries(this.providers);
  }

  get modelCount(): number {
    return countModels(this.providers);
  }

  get changeSummary(): string {
    return describeChanges(this.savedProviders, this.providers);
  }

  get dirty(): boolean {
    return (
      JSON.stringify(this.providers) !== JSON.stringify(this.savedProviders) ||
      this.defaultProvider !== this.savedDefaults.provider ||
      this.defaultModel !== this.savedDefaults.model
    );
  }

  async load(nodeName: string): Promise<void> {
    if (!this.ws || !nodeName) return;
    this.nodeName = nodeName;
    this.loading = true;
    this.error = null;
    try {
      const res = (await this.ws.emit('providers:get', { nodeName })) as NodeProviderConfig;
      runInAction(() => {
        this.configPath = res.configPath;
        this.providers = clone(res.providers);
        this.savedProviders = clone(res.providers);
        this.defaultProvider = res.defaultProvider;
        this.defaultModel = res.defaultModel;
        this.savedDefaults = { provider: res.defaultProvider, model: res.defaultModel };
        this.loadedNode = nodeName;
      });
    } catch (err) {
      runInAction(() => {
        this.error = err instanceof Error ? err.message : String(err);
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }

  setProvider(id: string, def: RawProvider): void {
    this.providers = { ...this.providers, [id]: def };
    if (!this.defaultProvider) {
      this.defaultProvider = id;
      this.defaultModel = firstAlias(def);
    }
  }

  removeProvider(id: string): void {
    const next = { ...this.providers };
    delete next[id];
    this.providers = next;
    if (this.defaultProvider === id) {
      this.defaultProvider = Object.keys(next)[0] ?? '';
      this.defaultModel = firstAlias(next[this.defaultProvider]);
    }
  }

  setDefaultProvider(id: string): void {
    this.defaultProvider = id;
    const aliases = Object.keys((this.providers[id]?.models ?? {}) as Record<string, unknown>);
    if (!aliases.includes(this.defaultModel)) this.defaultModel = aliases[0] ?? '';
  }

  setDefaultModel(alias: string): void {
    this.defaultModel = alias;
  }

  discard(): void {
    this.providers = clone(this.savedProviders);
    this.defaultProvider = this.savedDefaults.provider;
    this.defaultModel = this.savedDefaults.model;
    this.error = null;
  }

  async save(): Promise<boolean> {
    if (!this.ws || !this.nodeName) return false;
    this.saving = true;
    this.error = null;
    try {
      await this.ws.emit('providers:save', {
        nodeName: this.nodeName,
        providers: this.providers,
        defaultProvider: this.defaultProvider,
        defaultModel: this.defaultModel,
      });
      runInAction(() => {
        this.savedProviders = clone(this.providers);
        this.savedDefaults = { provider: this.defaultProvider, model: this.defaultModel };
      });
      return true;
    } catch (err) {
      runInAction(() => {
        this.error = err instanceof Error ? err.message : String(err);
      });
      return false;
    } finally {
      runInAction(() => {
        this.saving = false;
      });
    }
  }

  async test(baseUrl: string): Promise<ProviderTestResult> {
    if (!this.ws || !this.nodeName) return { ok: false, detail: 'No node is connected.' };
    try {
      return (await this.ws.emit('providers:test', { nodeName: this.nodeName, baseUrl })) as ProviderTestResult;
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  clearError(): void {
    this.error = null;
  }
}
