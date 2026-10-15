import { observer } from 'mobx-react-lite';
import { useConfigStore, useProviderConfig } from '~/stores/context';
import { countModels, diffCapabilities } from '~/lib/provider-config';

export type SectionId = 'providers' | 'projects' | 'node' | 'storage';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-2">
      <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">{label}</span>
      <span className="text-xs font-mono text-right break-all">{value}</span>
    </div>
  );
}

/**
 * The right-hand pane. Its job is the one thing the main pane cannot show: what
 * the node currently advertises to the board, and what a save would change about
 * it. Provider config is invisible to the app until it becomes capabilities on a
 * node, so that comparison is the whole config → capabilities → UI chain.
 */
export default observer(function CapabilityEcho({ section }: { section: SectionId }) {
  const config = useConfigStore();
  const providerConfig = useProviderConfig();
  const nodeName = providerConfig.loadedNode;
  const defaults = config.nodeByName(nodeName)?.defaults;

  if (section === 'providers') {
    const live = config.providersForNode(nodeName);
    const liveIds = Object.keys(live);
    const draftIds = Object.keys(providerConfig.providers);
    const diff = diffCapabilities(live, providerConfig.providers);
    const connected = config.nodeByName(nodeName)?.connected ?? false;

    return (
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Live capabilities</p>
            {providerConfig.dirty && (
              <span className="text-[10px] uppercase tracking-wide text-amber-500 border border-amber-500/40 rounded px-1.5 py-0.5">
                draft pending
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Read from the node, not from your draft. The board builds its model dropdown from exactly this list.
          </p>
        </div>

        {!connected && (
          <p className="text-xs text-destructive">
            {nodeName || 'This node'} is offline, so the board offers no models at all right now.
          </p>
        )}

        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          <Stat label="providers" value={`${liveIds.length}`} />
          <Stat label="models" value={`${countModels(live)}`} />
          <Stat label="node default" value={defaults ? `${defaults.provider} · ${defaults.model}` : '—'} />
          {liveIds.length > 0 && (
            <div className="px-3 py-2">
              <p className="text-xs text-muted-foreground mb-1.5">offered now</p>
              <div className="flex flex-wrap gap-1.5">
                {liveIds.map((id) => (
                  <span key={id} className="text-[11px] font-mono border border-border rounded px-1.5 py-0.5">
                    {id}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {providerConfig.dirty && (
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">After save</p>
            <div className="rounded-lg border border-border bg-card divide-y divide-border mt-1">
              <Stat label="providers" value={`${draftIds.length}`} />
              <Stat label="models" value={`${countModels(providerConfig.providers)}`} />
              <div className="px-3 py-2 space-y-1.5">
                {diff.added.length > 0 && <ChangeRow sign="+" ids={diff.added} note="new in the dropdown" />}
                {diff.edited.length > 0 && <ChangeRow sign="~" ids={diff.edited} note="different models" />}
                {diff.removed.length > 0 && <ChangeRow sign="−" ids={diff.removed} note="leaves the dropdown" />}
                {diff.added.length === 0 && diff.edited.length === 0 && diff.removed.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Same providers and models — this save changes settings, not what the board offers.
                  </p>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Sessions already running keep the provider they started with.
            </p>
          </div>
        )}
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

function ChangeRow({ sign, ids, note }: { sign: string; ids: string[]; note: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs font-mono text-primary w-2 shrink-0">{sign}</span>
      <span className="text-xs font-mono break-all">{ids.join(', ')}</span>
      <span className="text-[11px] text-muted-foreground ml-auto shrink-0">{note}</span>
    </div>
  );
}
