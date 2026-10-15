import { observer } from 'mobx-react-lite';
import { useConfigStore, useProviderConfig } from '~/stores/context';
import { ScrollArea } from '~/components/ui/scroll-area';

export type SectionId = 'providers' | 'projects' | 'node' | 'storage';

/**
 * The right-hand pane. Its whole point is that provider config is not visible in
 * this app until it becomes capabilities on a node, so while providers are being
 * edited it renders the board's model dropdown from the working copy — the
 * config → capabilities → UI chain, made observable.
 */
export default observer(function CapabilityEcho({ section }: { section: SectionId }) {
  const config = useConfigStore();
  const providerConfig = useProviderConfig();
  const nodeName = providerConfig.loadedNode;
  const defaults = config.nodeByName(nodeName)?.defaults;

  if (section === 'providers') {
    const entries = providerConfig.entries;
    return (
      <div className="space-y-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Model dropdown</p>
          <p className="text-xs text-muted-foreground mt-1">
            Built from the node&apos;s advertised capabilities. This is the working copy — save to make it real.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border text-sm">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Card model</span>
            <span>
              {providerConfig.defaultProvider || 'No provider'}{' '}
              <span className="text-xs font-mono text-muted-foreground">{providerConfig.defaultModel}</span>
            </span>
          </div>
          <ScrollArea className="max-h-64">
            <div className="p-1.5 space-y-0.5">
              {entries.length === 0 && (
                <p className="text-xs text-muted-foreground p-3 text-center">
                  No providers — the board shows an empty dropdown and cards cannot start.
                </p>
              )}
              {entries.map(([id, def]) => (
                <div key={id}>
                  <p className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {String(def.label ?? id)}
                  </p>
                  {Object.entries((def.models ?? {}) as Record<string, { label?: string; contextWindow?: number }>).map(
                    ([alias, m]) => (
                      <div key={alias} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
                        <span>{String(m.label ?? alias)}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {Number(m.contextWindow ?? 0).toLocaleString()}
                        </span>
                        <span className="ml-auto text-[11px] font-mono text-muted-foreground">{alias}</span>
                      </div>
                    ),
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Write path</p>
          <ol className="mt-2 space-y-2 text-xs text-muted-foreground">
            <li>
              <span className="text-foreground">1 · Validate</span> — the node checks the merged file before writing, so
              a rejected save changes nothing.
            </li>
            <li>
              <span className="text-foreground">2 · Write</span> — the node rewrites its own config file, atomically,
              keeping the rest of the document.
            </li>
            <li>
              <span className="text-foreground">3 · Re-advertise</span> — fresh capabilities reach every open board;
              running sessions keep the provider they started with.
            </li>
          </ol>
        </div>
      </div>
    );
  }

  if (section === 'projects') {
    return (
      <div className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Project defaults</p>
        <p className="text-xs text-muted-foreground">
          A project set to <span className="font-mono">Default</span> resolves to this node&apos;s default provider and
          model at run time — it does not copy them.
        </p>
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs space-y-1.5">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">node default</span>
            <span className="font-mono">
              {defaults ? `${defaults.provider} · ${defaults.model}` : '—'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (section === 'node') {
    return (
      <div className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Wiring</p>
        <p className="text-xs text-muted-foreground">
          Providers come from the node, capabilities come back over the socket, and the backend caches them per node.
          Nothing in the app holds its own copy of a provider list.
        </p>
        <p className="text-xs text-muted-foreground">
          Editing here writes the node&apos;s file directly — it needs no restart, and other nodes are unaffected.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Cache</p>
      <p className="text-xs text-muted-foreground">
        Clearing the local cache only drops this browser&apos;s offline snapshot. Cards, projects and provider config
        live on the node and are untouched.
      </p>
    </div>
  );
});
