export type RawProvider = Record<string, unknown>;
export type RawProviders = Record<string, RawProvider>;

export interface ModelRow {
  alias: string;
  label: string;
  modelID: string;
  contextWindow: number;
}

export type AuthKind = 'apiKey' | 'authToken' | 'oauth';

export interface ProviderForm {
  id: string;
  label: string;
  type: string;
  auth: AuthKind;
  secret: string;
  baseUrl: string;
  models: ModelRow[];
  aliases: { subagent: string; lightweight: string };
  agents: Record<string, string>;
}

export interface Preset {
  key: string;
  label: string;
  description: string;
  color: string;
  make: () => ProviderForm;
}

const AGENT_SLOTS = ['Explore', 'Plan', 'general-purpose'] as const;

export const AGENTS = AGENT_SLOTS;

/**
 * Providers carry more than this form shows (region, profile, per-model thinking
 * level and summarize threshold, plus anything a future version adds). The form
 * preserves those keys verbatim rather than dropping them on save.
 */
export function formFromProvider(id: string, def: RawProvider): ProviderForm {
  const models = (def.models ?? {}) as Record<string, Record<string, unknown>>;
  const aliases = (def.aliases ?? {}) as Record<string, string>;
  const agents = (def.agents ?? {}) as Record<string, string>;
  const auth: AuthKind = def.oauth != null ? 'oauth' : def.authToken != null ? 'authToken' : 'apiKey';

  return {
    id,
    label: String(def.label ?? id),
    type: String(def.type ?? ''),
    auth,
    secret: String(def[auth] ?? ''),
    baseUrl: String(def.baseUrl ?? ''),
    models: Object.entries(models).map(([alias, m]) => ({
      alias,
      label: String(m.label ?? alias),
      modelID: String(m.modelID ?? ''),
      contextWindow: Number(m.contextWindow ?? 200000),
    })),
    aliases: { subagent: String(aliases.subagent ?? ''), lightweight: String(aliases.lightweight ?? '') },
    agents: Object.fromEntries(AGENT_SLOTS.filter((a) => agents[a] != null).map((a) => [a, String(agents[a])])),
  };
}

export function providerFromForm(form: ProviderForm, original?: RawProvider): RawProvider {
  const def: RawProvider = { ...(original ?? {}) };
  const previousModels = (original?.models ?? {}) as Record<string, Record<string, unknown>>;

  def.label = form.label.trim() || form.id;
  def.models = Object.fromEntries(
    form.models.map((m) => {
      const alias = m.alias.trim();
      return [
        alias,
        { ...(previousModels[alias] ?? {}), label: m.label.trim() || alias, modelID: m.modelID.trim(), contextWindow: m.contextWindow },
      ];
    }),
  );

  delete def.apiKey;
  delete def.authToken;
  delete def.oauth;
  def[form.auth] = form.secret.trim();

  if (form.type) def.type = form.type;
  else delete def.type;

  if (form.baseUrl.trim()) def.baseUrl = form.baseUrl.trim();
  else delete def.baseUrl;

  if (form.aliases.subagent || form.aliases.lightweight) {
    def.aliases = {
      ...(form.aliases.subagent ? { subagent: form.aliases.subagent } : {}),
      ...(form.aliases.lightweight ? { lightweight: form.aliases.lightweight } : {}),
    };
  } else {
    delete def.aliases;
  }

  const agents = Object.fromEntries(Object.entries(form.agents).filter(([, v]) => v));
  if (Object.keys(agents).length > 0) def.agents = agents;
  else delete def.agents;

  return def;
}

/** Field-level problems the form can see; the node validates the merged file again. */
export function validateForm(form: ProviderForm, otherIds: string[]): string[] {
  const problems: string[] = [];
  const id = form.id.trim();

  if (!id) problems.push('Give the provider an id, e.g. anthropic.');
  else if (!/^[A-Za-z0-9][\w.-]*$/.test(id)) problems.push('The id must start with a letter or digit and contain no spaces.');
  else if (otherIds.includes(id)) problems.push(`A provider with the id "${id}" already exists.`);

  const aliases = form.models.map((m) => m.alias.trim()).filter(Boolean);
  if (aliases.length === 0) problems.push('Add at least one model — the board builds its model dropdown from them.');
  if (new Set(aliases).size !== aliases.length) problems.push('Two models share the same alias.');

  for (const m of form.models) {
    const name = m.alias.trim() || m.modelID.trim() || 'model';
    if (!m.alias.trim() || !m.modelID.trim()) problems.push(`"${name}" needs both an alias and a model ID.`);
    if (!Number.isFinite(m.contextWindow) || m.contextWindow <= 0) problems.push(`"${name}" needs a positive context window.`);
  }

  if (form.auth !== 'oauth' && !form.baseUrl.trim()) problems.push('Add a base URL, or switch authentication to an OAuth extension.');
  if (!form.secret.trim()) {
    problems.push(form.auth === 'oauth' ? 'Name the Pi extension to use, e.g. claude-max.' : 'Paste the key or token for this provider.');
  }

  for (const [slot, ref] of [
    ['subagent tier', form.aliases.subagent],
    ['lightweight tier', form.aliases.lightweight],
    ...Object.entries(form.agents).map(([agent, ref]) => [`agent ${agent}`, ref] as [string, string]),
  ] as Array<[string, string]>) {
    if (ref && !aliases.includes(ref)) problems.push(`The ${slot} points at "${ref}", which is not one of this provider's models.`);
  }

  return problems;
}

export function countModels(providers: Record<string, unknown>): number {
  return Object.values(providers).reduce<number>((n, p) => n + Object.keys(modelsOf(p)).length, 0);
}

function modelsOf(provider: unknown): Record<string, unknown> {
  const models = provider && typeof provider === 'object' ? (provider as { models?: unknown }).models : undefined;
  return models && typeof models === 'object' ? (models as Record<string, unknown>) : {};
}

/**
 * Only the part of a provider the board's model dropdown renders. A node's
 * advertised capabilities and the raw file describe a provider differently, so
 * the two can only be compared on their ids and model aliases.
 */
export function capabilityIds(providers: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(providers).map(([id, p]) => [id, Object.keys(modelsOf(p))]));
}

/** What the dropdown gains and loses between the node's advertised set and a draft. */
export function diffCapabilities(
  live: Record<string, unknown>,
  draft: Record<string, unknown>,
): { added: string[]; removed: string[]; edited: string[] } {
  const before = capabilityIds(live);
  const after = capabilityIds(draft);
  return {
    added: Object.keys(after).filter((id) => !before[id]),
    removed: Object.keys(before).filter((id) => !after[id]),
    edited: Object.keys(after).filter((id) => before[id] && before[id].join() !== after[id].join()),
  };
}

function diffProviders(before: RawProviders, after: RawProviders): string[] {
  const beforeIds = Object.keys(before);
  const afterIds = Object.keys(after);
  const parts: string[] = [];
  const added = afterIds.filter((id) => !beforeIds.includes(id)).length;
  const removed = beforeIds.filter((id) => !afterIds.includes(id)).length;
  const edited = afterIds.filter((id) => before[id] && JSON.stringify(before[id]) !== JSON.stringify(after[id])).length;
  if (added) parts.push(`+${added} provider${added > 1 ? 's' : ''}`);
  if (removed) parts.push(`−${removed} provider${removed > 1 ? 's' : ''}`);
  if (edited) parts.push(`~${edited} edited`);
  return parts;
}

/** Footer summary of what a save would change. */
export function describeChanges(saved: RawProviders, working: RawProviders): string {
  return diffProviders(saved, working).join(', ');
}

export const PRESETS: Preset[] = [
  {
    key: 'anthropic',
    label: 'Anthropic API',
    description: 'An API key against api.anthropic.com',
    color: 'var(--neon-cyan)',
    make: () => ({
      id: 'anthropic',
      label: 'Anthropic',
      type: 'anthropic',
      auth: 'apiKey',
      secret: '',
      baseUrl: 'https://api.anthropic.com',
      models: [
        { alias: 'opus', label: 'Opus', modelID: 'claude-opus-4-7', contextWindow: 1000000 },
        { alias: 'sonnet', label: 'Sonnet', modelID: 'claude-sonnet-4-6', contextWindow: 1000000 },
        { alias: 'haiku', label: 'Haiku', modelID: 'claude-haiku-4-5-20251001', contextWindow: 200000 },
      ],
      aliases: { subagent: 'sonnet', lightweight: 'haiku' },
      agents: {},
    }),
  },
  {
    key: 'claude-max',
    label: 'Claude Max',
    description: 'Subscription OAuth through the claude-max Pi extension',
    color: 'var(--neon-violet)',
    make: () => ({
      id: 'claude-max',
      label: 'Claude Max',
      type: 'anthropic',
      auth: 'oauth',
      secret: 'claude-max',
      baseUrl: 'https://api.anthropic.com',
      models: [
        { alias: 'opus', label: 'Opus', modelID: 'claude-opus-4-7', contextWindow: 1000000 },
        { alias: 'sonnet', label: 'Sonnet', modelID: 'claude-sonnet-4-6', contextWindow: 1000000 },
      ],
      aliases: { subagent: 'sonnet', lightweight: 'sonnet' },
      agents: {},
    }),
  },
  {
    key: 'openai-compatible',
    label: 'OpenAI-compatible',
    description: 'Any base URL that speaks the OpenAI shape',
    color: 'var(--neon-lime)',
    make: () => ({
      id: 'openai',
      label: 'OpenAI',
      type: '',
      auth: 'apiKey',
      secret: '',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ alias: 'gpt5', label: 'GPT-5', modelID: 'gpt-5', contextWindow: 400000 }],
      aliases: { subagent: 'gpt5', lightweight: 'gpt5' },
      agents: {},
    }),
  },
];

export function blankForm(): ProviderForm {
  return {
    id: '',
    label: '',
    type: '',
    auth: 'apiKey',
    secret: '',
    baseUrl: '',
    models: [{ alias: 'sonnet', label: 'Sonnet', modelID: '', contextWindow: 200000 }],
    aliases: { subagent: '', lightweight: '' },
    agents: {},
  };
}
