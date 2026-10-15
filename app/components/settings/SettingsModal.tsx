import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { X, Zap, FolderOpen, Server, Database, PanelRight } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { ScrollArea } from '~/components/ui/scroll-area';
import { useConfigStore, useProviderConfig, useProjectStore } from '~/stores/context';
import ProvidersSection from './ProvidersSection';
import ProjectsSection from './ProjectsSection';
import NodeSection from './NodeSection';
import StorageSection from './StorageSection';
import CapabilityEcho, { type SectionId } from './CapabilityEcho';

const SECTIONS: Array<{ id: SectionId; label: string; icon: typeof Zap }> = [
  { id: 'providers', label: 'Providers', icon: Zap },
  { id: 'projects', label: 'Projects', icon: FolderOpen },
  { id: 'node', label: 'Node', icon: Server },
  { id: 'storage', label: 'Storage', icon: Database },
];

const TITLES: Record<SectionId, string> = {
  providers: 'Providers',
  projects: 'Projects',
  node: 'Node',
  storage: 'Storage',
};

/**
 * Settings as a holy-grail frame: header, left rail, main pane, inspector, and a
 * footer that owns save/discard. The footer sits outside the section because the
 * provider draft outlives the pane the user is looking at — switching to Storage
 * mid-edit must not hide unsaved work.
 */
export default observer(function SettingsModal({ onClose }: { onClose: () => void }) {
  const config = useConfigStore();
  const providerConfig = useProviderConfig();
  const projects = useProjectStore();
  const [section, setSection] = useState<SectionId>('providers');
  const [showAside, setShowAside] = useState(false);
  const [saved, setSaved] = useState(false);

  const nodeName = config.connectedNodes[0]?.name ?? '';

  useEffect(() => {
    if (nodeName) void providerConfig.load(nodeName);
  }, [nodeName, providerConfig]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const counts: Record<SectionId, string> = {
    providers: `${providerConfig.entries.length}`,
    projects: `${projects.all.length}`,
    node: '',
    storage: '',
  };

  async function handleSave() {
    setSaved(false);
    const ok = await providerConfig.save();
    setSaved(ok);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <header className="h-14 shrink-0 flex items-center gap-3 px-4 border-b border-border bg-card">
        <h1 className="text-base font-semibold">Settings</h1>
        <span className="text-xs text-muted-foreground">/</span>
        <span className="text-xs text-muted-foreground">{TITLES[section]}</span>
        <div className="flex-1" />
        {providerConfig.dirty && (
          <span className="text-xs text-amber-500 border border-amber-500/40 rounded-full px-2 py-1">
            {providerConfig.changeSummary || 'unsaved changes'} — not applied yet
          </span>
        )}
        <span className="flex items-center gap-2 text-xs text-muted-foreground border border-border rounded-full px-2.5 py-1">
          <span className={`size-1.5 rounded-full ${nodeName ? 'bg-emerald-400' : 'bg-destructive'}`} />
          <span className="font-mono">{nodeName || 'no node connected'}</span>
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="xl:hidden text-muted-foreground"
          title="Toggle inspector"
          onClick={() => setShowAside((v) => !v)}
        >
          <PanelRight className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="text-muted-foreground" title="Close settings (Esc)" onClick={onClose}>
          <X className="size-5" />
        </Button>
      </header>

      {/* ── rail · main · inspector ────────────────────────────────────── */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[15rem_minmax(0,1fr)_21rem]">
        <nav className="border-b xl:border-b-0 xl:border-r border-border bg-sidebar/60 p-2 grid grid-cols-2 gap-1 xl:block xl:space-y-1">
          {SECTIONS.map(({ id, label, icon: Icon }) => {
            const active = section === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={active ? 'page' : undefined}
                className={`relative flex items-center gap-2 rounded-md px-2.5 py-2 text-sm whitespace-nowrap transition-colors ${
                  active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                }`}
              >
                {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />}
                <Icon className={`size-4 shrink-0 ${active ? 'text-primary' : ''}`} />
                <span className="flex-1 text-left font-medium">{label}</span>
                {counts[id] && (
                  <span className="text-[11px] tabular-nums text-muted-foreground border border-border rounded-full px-1.5">
                    {counts[id]}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <ScrollArea className="min-h-0">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
            {section === 'providers' && <ProvidersSection />}
            {section === 'projects' && <ProjectsSection />}
            {section === 'node' && <NodeSection />}
            {section === 'storage' && <StorageSection />}
          </div>
        </ScrollArea>

        <aside
          className={`border-l border-border bg-card/40 min-h-0 ${
            showAside ? 'fixed inset-y-14 right-0 w-80 z-10 shadow-2xl bg-background' : 'hidden xl:block'
          }`}
        >
          <ScrollArea className="h-full">
            <div className="p-4">
              <CapabilityEcho section={section} />
            </div>
          </ScrollArea>
        </aside>
      </div>

      {/* ── footer ─────────────────────────────────────────────────────── */}
      <footer className="h-14 shrink-0 flex items-center gap-3 px-4 border-t border-border bg-card">
        <span className="text-xs text-muted-foreground">
          {providerConfig.saving
            ? 'Saving to the node…'
            : providerConfig.dirty
              ? `${providerConfig.changeSummary || 'unsaved changes'} — not applied yet`
              : saved
                ? `Saved · ${providerConfig.modelCount} models live`
                : `Up to date · ${providerConfig.entries.length} provider${providerConfig.entries.length === 1 ? '' : 's'}, ${providerConfig.modelCount} models`}
        </span>
        <span className="flex-1" />
        <span className="hidden md:block text-[11px] font-mono text-muted-foreground truncate max-w-xs">
          {providerConfig.configPath}
        </span>
        {providerConfig.dirty && (
          <>
            <Button variant="outline" size="sm" disabled={providerConfig.saving} onClick={() => providerConfig.discard()}>
              Discard
            </Button>
            <Button size="sm" disabled={providerConfig.saving} onClick={() => void handleSave()}>
              {providerConfig.saving ? 'Saving…' : 'Save to node'}
            </Button>
          </>
        )}
      </footer>
    </div>
  );
});
