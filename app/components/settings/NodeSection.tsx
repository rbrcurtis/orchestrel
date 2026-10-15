import { observer } from 'mobx-react-lite';
import { useConfigStore, useProviderConfig } from '~/stores/context';
import { Card, CardContent } from '~/components/ui/card';
import { Alert, AlertDescription } from '~/components/ui/alert';

export default observer(function NodeSection() {
  const config = useConfigStore();
  const providerConfig = useProviderConfig();
  const nodeName = providerConfig.loadedNode || config.connectedNodes[0]?.name || '';
  const node = config.nodeByName(nodeName);

  const facts: Array<[string, string]> = [
    ['name', nodeName || 'none connected'],
    ['state', node ? (node.connected ? 'connected' : 'offline') : 'unknown'],
    ['providers', `${Object.keys(providerConfig.providers).length}`],
    ['models', `${providerConfig.modelCount}`],
    ['default', providerConfig.defaultProvider ? `${providerConfig.defaultProvider} · ${providerConfig.defaultModel}` : '—'],
  ];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Node</h2>
        <p className="text-xs text-muted-foreground max-w-prose mt-1">
          This app supervises one orcd node on loopback. Providers are stored on the node itself, next to the data it
          serves.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {facts.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-sm font-mono mt-1 break-all">{value}</p>
          </div>
        ))}
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Config file</p>
        <Card>
          <CardContent className="py-4">
            <p className="text-xs text-muted-foreground">Providers are written here by the node itself.</p>
            <p className="text-sm font-mono mt-1 break-all">
              {providerConfig.configPath || 'not loaded'}
            </p>
          </CardContent>
        </Card>
      </div>

      <Alert>
        <AlertDescription>
          <p>
            Pi resources — auth, model registry, skills and prompts — are read from{' '}
            <span className="font-mono">~/.pi/agent</span>, not from this app. Providers configured here only add
            routing on top of them.
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
});
