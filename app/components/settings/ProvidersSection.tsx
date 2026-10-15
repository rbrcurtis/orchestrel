import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Plus, Pencil, Trash2, Zap, X, ChevronRight } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '~/components/ui/card';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui/select';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '~/components/ui/collapsible';
import { useProviderConfig, useConfigStore } from '~/stores/context';
import {
  AGENTS,
  PRESETS,
  blankForm,
  formFromProvider,
  providerFromForm,
  validateForm,
  type ProviderForm,
  type RawProvider,
} from '~/lib/provider-config';
import type { ProviderTestResult } from '../../../src/shared/ws-protocol';

const AUTH_LABELS: Record<ProviderForm['auth'], string> = {
  apiKey: 'API key',
  authToken: 'Auth token',
  oauth: 'OAuth (Pi extension)',
};

type Editing = { isNew: boolean; original?: RawProvider; form: ProviderForm };

export default observer(function ProvidersSection() {
  const store = useProviderConfig();
  const config = useConfigStore();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [test, setTest] = useState<{ id: string; result: ProviderTestResult | null } | null>(null);

  const nodeName = store.loadedNode;

  function startCreate(presetKey?: string) {
    const preset = PRESETS.find((p) => p.key === presetKey);
    setEditing({ isNew: true, form: preset ? preset.make() : blankForm() });
    setProblems([]);
  }

  function startEdit(id: string, def: RawProvider) {
    setEditing({ isNew: false, original: def, form: formFromProvider(id, def) });
    setProblems([]);
  }

  function patch(next: Partial<ProviderForm>) {
    setEditing((e) => (e ? { ...e, form: { ...e.form, ...next } } : e));
  }

  function commit() {
    if (!editing) return;
    const id = editing.form.id.trim();
    const takenIds = Object.keys(store.providers).filter((p) => editing.isNew || p !== id);
    const found = validateForm(editing.form, takenIds);
    if (found.length > 0) {
      setProblems(found);
      return;
    }
    store.setProvider(id, providerFromForm(editing.form, editing.original));
    setEditing(null);
    setProblems([]);
  }

  async function runTest(id: string, baseUrl: string) {
    setTest({ id, result: null });
    const result = await store.test(baseUrl);
    setTest({ id, result });
  }

  const nodeDefaults = config.nodeByName(nodeName)?.defaults;
  const defaultAliases = Object.keys((store.providers[store.defaultProvider]?.models ?? {}) as Record<string, unknown>);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Providers</h2>
          <p className="text-xs text-muted-foreground max-w-prose mt-1">
            Model endpoints this node can run cards against. The board builds its model dropdown from them, so an empty
            list means no session can start.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {store.modelCount > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {store.entries.length} provider{store.entries.length === 1 ? '' : 's'} · {store.modelCount} models
            </span>
          )}
          <Button size="sm" onClick={() => startCreate()} disabled={!nodeName}>
            <Plus />
            Add provider
          </Button>
        </div>
      </div>

      {store.error && (
        <Alert variant="destructive">
          <AlertDescription className="whitespace-pre-wrap">{store.error}</AlertDescription>
        </Alert>
      )}

      {editing && (
        <ProviderFormCard
          editing={editing}
          problems={problems}
          patch={patch}
          onCancel={() => {
            setEditing(null);
            setProblems([]);
          }}
          onCommit={commit}
          onTest={
            editing.form.baseUrl
              ? async () => {
                  setTest({ id: '__draft', result: null });
                  setTest({ id: '__draft', result: await store.test(editing.form.baseUrl) });
                }
              : undefined
          }
          testing={test?.id === '__draft' && test.result === null}
          testResult={test?.id === '__draft' ? test.result : null}
        />
      )}

      {store.entries.length === 0 && !editing && (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm">No providers configured.</p>
            <p className="text-xs text-muted-foreground mt-1 mb-5">
              Cards can&apos;t start until this node has at least one. Start from a preset:
            </p>
            <PresetRow onPick={startCreate} />
          </CardContent>
        </Card>
      )}

      {store.entries.map(([id, def]) => (
        <Card key={id}>
          <CardContent className="py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold">{String(def.label ?? id)}</span>
                  <span className="text-xs text-muted-foreground font-mono">{id}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
                    {AUTH_LABELS[(def.oauth != null ? 'oauth' : def.authToken != null ? 'authToken' : 'apiKey') as ProviderForm['auth']]}
                  </span>
                  {store.defaultProvider === id && (
                    <span className="text-[10px] uppercase tracking-wide text-primary border border-primary/40 rounded px-1.5 py-0.5">
                      node default
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1.5 font-mono truncate">
                  {def.oauth != null ? `oauth extension · ${String(def.oauth)}` : String(def.baseUrl ?? 'no baseUrl')}
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {Object.entries((def.models ?? {}) as Record<string, { modelID?: string }>).map(([alias, m]) => (
                    <span key={alias} className="text-[11px] font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5">
                      {alias}
                      <span className="text-muted-foreground/60"> → </span>
                      {m.modelID}
                    </span>
                  ))}
                </div>
                {test?.id === id && (
                  <Alert variant={test.result?.ok ? 'default' : 'destructive'} className="mt-2">
                    <AlertDescription>{test.result ? test.result.detail : 'Testing…'}</AlertDescription>
                  </Alert>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Test reachability"
                  disabled={test?.id === id && test.result === null}
                  onClick={() => void runTest(id, String(def.baseUrl ?? ''))}
                >
                  <Zap />
                </Button>
                <Button variant="ghost" size="icon-xs" title="Edit" onClick={() => startEdit(id, def)}>
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive hover:text-destructive"
                  title="Remove"
                  onClick={() => store.removeProvider(id)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      {store.entries.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Quick add</p>
          <PresetRow onPick={startCreate} />
        </div>
      )}

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Node defaults</p>
        <Card>
          <CardContent className="py-4 grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Default provider</label>
              <Select value={store.defaultProvider || undefined} onValueChange={(v) => store.setDefaultProvider(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No providers yet" />
                </SelectTrigger>
                <SelectContent position="popper" sideOffset={4}>
                  {store.entries.map(([id, def]) => (
                    <SelectItem key={id} value={id}>
                      {String(def.label ?? id)} ({id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                What a project set to <span className="font-mono">Default</span> resolves to
                {nodeDefaults ? ` — currently ${nodeDefaults.provider} · ${nodeDefaults.model}` : ''}.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Default model</label>
              <Select value={store.defaultModel || undefined} onValueChange={(v) => store.setDefaultModel(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent position="popper" sideOffset={4}>
                  {defaultAliases.map((alias) => (
                    <SelectItem key={alias} value={alias}>
                      {alias}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">Seeds new cards that don&apos;t name a model.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
});

function PresetRow({ onPick }: { onPick: (key: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {PRESETS.map((preset) => (
        <button
          key={preset.key}
          type="button"
          onClick={() => onPick(preset.key)}
          className="text-left rounded-lg border border-dashed border-border hover:border-primary/60 hover:bg-accent/40 transition-colors p-3"
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <span className="size-2 rounded-full" style={{ backgroundColor: preset.color }} />
            {preset.label}
          </span>
          <span className="block text-xs text-muted-foreground mt-1">{preset.description}</span>
        </button>
      ))}
    </div>
  );
}

function ProviderFormCard({
  editing,
  problems,
  patch,
  onCancel,
  onCommit,
  onTest,
  testing,
  testResult,
}: {
  editing: Editing;
  problems: string[];
  patch: (next: Partial<ProviderForm>) => void;
  onCancel: () => void;
  onCommit: () => void;
  onTest?: () => void;
  testing: boolean;
  testResult: ProviderTestResult | null;
}) {
  const form = editing.form;
  const aliases = form.models.map((m) => m.alias.trim()).filter(Boolean);

  function setModel(index: number, next: Partial<ProviderForm['models'][number]>) {
    patch({ models: form.models.map((m, i) => (i === index ? { ...m, ...next } : m)) });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{editing.isNew ? 'Add provider' : 'Edit provider'}</CardTitle>
        <CardDescription>
          Saved to the node&apos;s config file when you press save; sessions already running keep their provider.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Provider id</label>
            <Input
              className="font-mono"
              value={form.id}
              disabled={!editing.isNew}
              placeholder="anthropic"
              onChange={(e) => patch({ id: e.target.value.trim().replace(/[^A-Za-z0-9._-]/g, '') })}
            />
            <p className="text-xs text-muted-foreground mt-1 font-mono">key in providers:</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Label</label>
            <Input
              value={form.label}
              placeholder="Anthropic"
              onChange={(e) => patch({ label: e.target.value })}
            />
            <p className="text-xs text-muted-foreground mt-1">Shown in the board&apos;s dropdown.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Authentication</label>
            <Select
              value={form.auth}
              onValueChange={(v) => patch({ auth: v as ProviderForm['auth'], secret: '' })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={4}>
                {Object.entries(AUTH_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {form.auth === 'oauth' ? 'Uses a Pi extension; no key stored here.' : 'Stored in the node config file.'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Base URL</label>
            <Input
              className="font-mono"
              value={form.baseUrl}
              placeholder="https://api.anthropic.com"
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
            <p className="text-xs text-muted-foreground mt-1 font-mono">
              http(s)://host[/prefix] · env vars allowed: {'${VAR}'}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              {form.auth === 'oauth' ? 'Pi extension name' : form.auth === 'authToken' ? 'Auth token' : 'API key'}
            </label>
            <Input
              type={form.auth === 'oauth' ? 'text' : 'password'}
              className="font-mono"
              value={form.secret}
              placeholder={form.auth === 'oauth' ? 'claude-max' : ''}
              onChange={(e) => patch({ secret: e.target.value })}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {form.auth === 'oauth'
                ? 'Must match an installed Pi extension at ~/.pi/agent/extensions/<name>.'
                : 'Sent to the node and written to its private config file.'}
            </p>
          </div>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Models</p>
          <div className="hidden md:grid grid-cols-[1fr_1.4fr_1.2fr_7rem_1.5rem] gap-2 px-0.5 pb-1 text-[11px] text-muted-foreground">
            <span>alias</span>
            <span>model ID</span>
            <span>label</span>
            <span>context</span>
            <span />
          </div>
          <div className="space-y-2">
            {form.models.map((m, i) => (
              <div key={i} className="grid grid-cols-[1fr_1.4fr_1.2fr_7rem_1.5rem] gap-2 items-center">
                <Input
                  className="font-mono h-8 text-xs"
                  value={m.alias}
                  placeholder="sonnet"
                  onChange={(e) => setModel(i, { alias: e.target.value.trim() })}
                />
                <Input
                  className="font-mono h-8 text-xs"
                  value={m.modelID}
                  placeholder="claude-sonnet-4-6"
                  onChange={(e) => setModel(i, { modelID: e.target.value })}
                />
                <Input
                  className="h-8 text-xs"
                  value={m.label}
                  placeholder="Sonnet"
                  onChange={(e) => setModel(i, { label: e.target.value })}
                />
                <Input
                  className="font-mono h-8 text-xs"
                  inputMode="numeric"
                  value={m.contextWindow}
                  onChange={(e) => setModel(i, { contextWindow: Number(e.target.value.replace(/\D/g, '')) })}
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive hover:text-destructive"
                  title="Remove model"
                  disabled={form.models.length === 1}
                  onClick={() => patch({ models: form.models.filter((_, j) => j !== i) })}
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            size="xs"
            className="mt-2"
            onClick={() =>
              patch({ models: [...form.models, { alias: '', label: '', modelID: '', contextWindow: 200000 }] })
            }
          >
            <Plus />
            Add model
          </Button>
        </div>

        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ChevronRight className="size-3.5" />
            Advanced — provider type, subagent tiers, per-agent overrides
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Provider type</label>
                <Select value={form.type || 'auto'} onValueChange={(v) => patch({ type: v === 'auto' ? '' : v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" sideOffset={4}>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="anthropic">anthropic</SelectItem>
                    <SelectItem value="bedrock">bedrock</SelectItem>
                    <SelectItem value="google">google</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Subagent tier</label>
                <Select
                  value={form.aliases.subagent || 'none'}
                  onValueChange={(v) => patch({ aliases: { ...form.aliases, subagent: v === 'none' ? '' : v } })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" sideOffset={4}>
                    <SelectItem value="none">—</SelectItem>
                    {aliases.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">general-purpose agent</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">Lightweight tier</label>
                <Select
                  value={form.aliases.lightweight || 'none'}
                  onValueChange={(v) => patch({ aliases: { ...form.aliases, lightweight: v === 'none' ? '' : v } })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" sideOffset={4}>
                    <SelectItem value="none">—</SelectItem>
                    {aliases.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">Explore agent</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {AGENTS.map((agent) => (
                <div key={agent}>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">agent · {agent}</label>
                  <Select
                    value={form.agents[agent] || 'none'}
                    onValueChange={(v) => patch({ agents: { ...form.agents, [agent]: v === 'none' ? '' : v } })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper" sideOffset={4}>
                      <SelectItem value="none">inherit tier</SelectItem>
                      {aliases.map((a) => (
                        <SelectItem key={a} value={a}>
                          {a}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {problems.length > 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              <ul className="list-disc pl-4 space-y-0.5">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {testResult && (
          <Alert variant={testResult.ok ? 'default' : 'destructive'}>
            <AlertDescription>{testResult.detail}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-[11px] font-mono text-muted-foreground">providers.{form.id || '<id>'}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            {onTest && (
              <Button variant="outline" size="sm" disabled={testing} onClick={onTest}>
                <Zap />
                {testing ? 'Testing…' : 'Test'}
              </Button>
            )}
            <Button size="sm" onClick={onCommit}>
              {editing.isNew ? 'Add provider' : 'Apply'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
