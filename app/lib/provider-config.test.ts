import { describe, expect, it } from 'vitest';
import {
  blankForm,
  capabilityIds,
  countModels,
  describeChanges,
  diffCapabilities,
  formFromProvider,
  providerFromForm,
  validateForm,
  type ProviderForm,
} from './provider-config';

const ANTHROPIC = {
  label: 'Anthropic',
  type: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: '${ANTHROPIC_API_KEY}',
  region: 'us-east-1',
  profile: 'work',
  aliases: { subagent: 'sonnet', lightweight: 'haiku' },
  agents: { Explore: 'haiku' },
  models: {
    sonnet: { label: 'Sonnet', modelID: 'claude-sonnet-4-6', contextWindow: 1000000, summarizeThreshold: 0.7 },
  },
};

function form(patch: Partial<ProviderForm> = {}): ProviderForm {
  return {
    ...blankForm(),
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://x',
    secret: 'k',
    models: [{ alias: 'sonnet', label: 'Sonnet', modelID: 'claude-sonnet-4-6', contextWindow: 1000000 }],
    ...patch,
  };
}

describe('formFromProvider', () => {
  it('reads the auth kind from whichever secret key is present', () => {
    expect(formFromProvider('anthropic', ANTHROPIC).auth).toBe('apiKey');
    expect(formFromProvider('anthropic', { ...ANTHROPIC, oauth: 'claude-max' }).auth).toBe('oauth');
    expect(formFromProvider('anthropic', { ...ANTHROPIC, authToken: 't' }).auth).toBe('authToken');
  });

  it('keeps the unresolved env template as the field value', () => {
    expect(formFromProvider('anthropic', ANTHROPIC).secret).toBe('${ANTHROPIC_API_KEY}');
  });

  it('fills model rows and tier slots', () => {
    const f = formFromProvider('anthropic', ANTHROPIC);
    expect(f.models).toEqual([
      { alias: 'sonnet', label: 'Sonnet', modelID: 'claude-sonnet-4-6', contextWindow: 1000000 },
    ]);
    expect(f.aliases).toEqual({ subagent: 'sonnet', lightweight: 'haiku' });
    expect(f.agents).toEqual({ Explore: 'haiku' });
  });
});

describe('providerFromForm', () => {
  it('preserves keys the form does not show', () => {
    const def = providerFromForm(formFromProvider('anthropic', ANTHROPIC), ANTHROPIC);

    expect(def.region).toBe('us-east-1');
    expect(def.profile).toBe('work');
    expect((def.models as Record<string, Record<string, unknown>>).sonnet!.summarizeThreshold).toBe(0.7);
    expect(def.apiKey).toBe('${ANTHROPIC_API_KEY}');
  });

  it('drops the previous secret when the auth kind changes', () => {
    const f = formFromProvider('anthropic', ANTHROPIC);
    const def = providerFromForm({ ...f, auth: 'oauth', secret: 'claude-max' }, ANTHROPIC);

    expect(def.oauth).toBe('claude-max');
    expect(def.apiKey).toBeUndefined();
    expect(def.authToken).toBeUndefined();
  });

  it('omits empty optional fields instead of writing blanks', () => {
    const def = providerFromForm(form({ type: '', baseUrl: 'https://x', aliases: { subagent: '', lightweight: '' }, agents: {} }));

    expect(def.type).toBeUndefined();
    expect(def.aliases).toBeUndefined();
    expect(def.agents).toBeUndefined();
    expect(def.label).toBe('Anthropic');
  });

  it('falls back to the alias for a blank model label', () => {
    const def = providerFromForm(form({ models: [{ alias: 'sonnet', label: '', modelID: 'm', contextWindow: 1000 }] }));
    expect((def.models as Record<string, Record<string, unknown>>).sonnet!.label).toBe('sonnet');
  });
});

describe('validateForm', () => {
  it('accepts a complete provider', () => {
    expect(validateForm(form(), [])).toEqual([]);
  });

  it('rejects a duplicate id, a missing model id and an empty model list', () => {
    expect(validateForm(form(), ['anthropic']).join('\n')).toMatch(/already exists/);
    expect(validateForm(form({ models: [] }), []).join('\n')).toMatch(/at least one model/);
    expect(
      validateForm(form({ models: [{ alias: 'sonnet', label: 'S', modelID: '', contextWindow: 1000 }] }), []).join('\n'),
    ).toMatch(/needs both an alias and a model ID/);
  });

  it('requires a base url unless the provider is oauth-backed, and always a secret', () => {
    expect(validateForm(form({ baseUrl: '' }), []).join('\n')).toMatch(/Add a base URL/);
    expect(validateForm(form({ baseUrl: '', auth: 'oauth' }), []).join('\n')).not.toMatch(/Add a base URL/);
    expect(validateForm(form({ secret: '' }), []).join('\n')).toMatch(/Paste the key/);
    expect(validateForm(form({ auth: 'oauth', secret: '' }), []).join('\n')).toMatch(/Name the Pi extension/);
  });

  it('catches tier and agent references that name no model', () => {
    expect(validateForm(form({ aliases: { subagent: 'ghost', lightweight: '' } }), []).join('\n')).toMatch(
      /subagent tier points at "ghost"/,
    );
    expect(validateForm(form({ agents: { Explore: 'ghost' } }), []).join('\n')).toMatch(
      /agent Explore points at "ghost"/,
    );
  });
});

describe('describeChanges', () => {
  it('summarizes adds, removals and edits', () => {
    expect(describeChanges({}, { a: {}, b: {} })).toBe('+2 providers');
    expect(describeChanges({ a: {}, b: {} }, { a: {} })).toBe('−1 provider');
    expect(describeChanges({ a: { label: 'x' } }, { a: { label: 'y' } })).toBe('~1 edited');
    expect(describeChanges({ a: {} }, { a: {} })).toBe('');
  });
});

describe('countModels', () => {
  it('counts model aliases across providers', () => {
    expect(countModels({ a: { models: { x: {}, y: {} } }, b: { models: { z: {} } } })).toBe(3);
  });
});

describe('diffCapabilities', () => {
  // The node advertises providers in the capability shape; the draft is raw YAML.
  // Only ids and model aliases are comparable between them.
  const live = {
    ray: { id: 'ray', label: 'Ray', models: { coder: { alias: 'coder', label: 'Coder', contextWindow: 200000 } } },
    okkanti: { id: 'okkanti', label: 'Okkanti', models: { fast: { label: 'Fast' }, deep: { label: 'Deep' } } },
  };

  it('reports a shared provider as unchanged even though the shapes differ', () => {
    const draft = { ray: { label: 'Ray', baseUrl: 'https://x', models: { coder: { modelID: 'coder', contextWindow: 200000 } } } };
    expect(diffCapabilities(live, draft)).toEqual({ added: [], removed: ['okkanti'], edited: [] });
  });

  it('separates added, edited and removed providers by id', () => {
    const draft = {
      ray: { models: { coder: {}, reasoner: {} } },
      anthropic: { models: { sonnet: {} } },
    };
    expect(diffCapabilities(live, draft)).toEqual({ added: ['anthropic'], removed: ['okkanti'], edited: ['ray'] });
  });

  it('counts models across both shapes', () => {
    expect(countModels(live)).toBe(3);
    expect(countModels({ a: { models: { x: {}, y: {} } } })).toBe(2);
    expect(countModels({ a: { label: 'no models yet' } })).toBe(0);
  });

  it('projects a provider to its alias list', () => {
    expect(capabilityIds(live)).toEqual({ ray: ['coder'], okkanti: ['fast', 'deep'] });
  });
});
