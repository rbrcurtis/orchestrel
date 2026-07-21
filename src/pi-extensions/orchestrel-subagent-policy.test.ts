import { createEventBus, type EventBus, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { OrchestrelSubagentPolicy } from '../shared/subagent-policy';
import {
  createOrchestrelSubagentPolicyExtension,
  ORCHESTREL_SUBAGENT_POLICY_ENV,
} from './orchestrel-subagent-policy';

type Request = {
  agentType: string;
  requestedModel?: string;
  parentProvider: string;
  parentModel: string;
  decision?: { model: string; source: string } | { error: string };
};

const trackablePolicy: OrchestrelSubagentPolicy = {
  parentProvider: 'trackable',
  parentModel: 'trackable/auto',
  agents: {
    Explore: { model: 'trackable/claude-opus-4-6', source: 'lightweight tier' },
  },
  allowCrossProvider: false,
};

function loadPolicyFactory(bus: EventBus, policy: OrchestrelSubagentPolicy) {
  const shutdown = vi.fn();
  const pi = { events: bus, on: (event: string, handler: () => void) => {
    if (event === 'session_shutdown') shutdown.mockImplementation(handler);
  } } as unknown as ExtensionAPI;
  createOrchestrelSubagentPolicyExtension(policy)(pi);
  return shutdown;
}

function request(bus: EventBus, value: Omit<Request, 'decision'>): Request {
  const req: Request = { ...value };
  bus.emit('subagents:model-policy', req);
  return req;
}

describe('Orchestrel subagent policy extension', () => {
  it('returns mapped models and lets explicit same-provider models win', () => {
    const bus = createEventBus();
    loadPolicyFactory(bus, trackablePolicy);

    const mapped = request(bus, {
      agentType: 'Explore', parentProvider: 'trackable', parentModel: 'trackable/auto',
    });
    expect(mapped.decision).toEqual({ model: 'trackable/claude-opus-4-6', source: 'lightweight tier' });

    const explicit = request(bus, {
      agentType: 'Explore', requestedModel: 'trackable/auto',
      parentProvider: 'trackable', parentModel: 'trackable/auto',
    });
    expect(explicit.decision).toEqual({ model: 'trackable/auto', source: 'explicit' });
  });

  it('rejects explicit and parent providers that do not match policy', () => {
    const bus = createEventBus();
    loadPolicyFactory(bus, trackablePolicy);

    expect(request(bus, {
      agentType: 'Explore', requestedModel: 'anthropic/claude-opus-4-6',
      parentProvider: 'trackable', parentModel: 'trackable/auto',
    }).decision).toEqual({
      error: 'Subagent model "anthropic/claude-opus-4-6" is not allowed. This session uses provider "trackable".',
    });
    expect(request(bus, {
      agentType: 'Explore', parentProvider: 'anthropic', parentModel: 'anthropic/claude-opus-4-6',
    }).decision).toEqual({
      error: 'Subagent policy provider "trackable" does not match parent provider "anthropic".',
    });
  });

  it('keeps two event bus policies independent', () => {
    const trackable = createEventBus();
    const chatgpt = createEventBus();
    loadPolicyFactory(trackable, trackablePolicy);
    loadPolicyFactory(chatgpt, {
      parentProvider: 'chatgpt', parentModel: 'chatgpt/gpt-5.5',
      agents: { Explore: { model: 'chatgpt/gpt-5.4-nano', source: 'lightweight tier' } },
      allowCrossProvider: false,
    });

    expect(request(trackable, {
      agentType: 'Explore', parentProvider: 'trackable', parentModel: 'trackable/auto',
    }).decision).toEqual({ model: 'trackable/claude-opus-4-6', source: 'lightweight tier' });
    expect(request(chatgpt, {
      agentType: 'Explore', parentProvider: 'chatgpt', parentModel: 'chatgpt/gpt-5.5',
    }).decision).toEqual({ model: 'chatgpt/gpt-5.4-nano', source: 'lightweight tier' });
  });

  it('leaves a previous policy decision alone and unsubscribes at session shutdown', () => {
    const bus = createEventBus();
    const shutdown = loadPolicyFactory(bus, trackablePolicy);
    const decided = request(bus, {
      agentType: 'Explore', parentProvider: 'trackable', parentModel: 'trackable/auto',
    });
    decided.decision = { model: 'trackable/preselected', source: 'another policy' };
    bus.emit('subagents:model-policy', decided);
    expect(decided.decision).toEqual({ model: 'trackable/preselected', source: 'another policy' });

    shutdown();
    expect(request(bus, {
      agentType: 'Explore', parentProvider: 'trackable', parentModel: 'trackable/auto',
    }).decision).toBeUndefined();
  });

  it('fails closed when the default entrypoint policy is absent', async () => {
    const env = process.env[ORCHESTREL_SUBAGENT_POLICY_ENV];
    delete process.env[ORCHESTREL_SUBAGENT_POLICY_ENV];
    const { default: fromEnv } = await import('./orchestrel-subagent-policy');
    const bus = createEventBus();
    const pi = { events: bus, on: vi.fn() } as unknown as ExtensionAPI;

    expect(() => fromEnv(pi)).toThrow(`Missing ${ORCHESTREL_SUBAGENT_POLICY_ENV}`);
    if (env === undefined) delete process.env[ORCHESTREL_SUBAGENT_POLICY_ENV];
    else process.env[ORCHESTREL_SUBAGENT_POLICY_ENV] = env;
  });
});
