import { existsSync, readFileSync, readdirSync, rmdirSync, rmSync } from 'fs';
import { join } from 'path';
import type { ProviderDef } from './config';

export interface ProviderAliases {
  subagent?: string;
  lightweight?: string;
}

interface AgentPolicy {
  model: string;
  source: string;
}

export interface OrchestrelSubagentPolicy {
  parentProvider: string;
  parentModel: string;
  agents: Record<string, AgentPolicy>;
  allowCrossProvider: false;
}

const DEFAULT_TIERS = {
  'general-purpose': 'subagent',
  Explore: 'lightweight',
} as const;

const MANAGED_MARKER = 'managed_by: orchestrel';

function modelForTier(
  tier: keyof ProviderAliases,
  provider: Pick<ProviderDef, 'models' | 'aliases'>,
): string | undefined {
  const models = Object.values(provider.models);
  const first = models[0];
  if (!first) return undefined;

  if (provider.aliases) {
    const key = provider.aliases[tier];
    if (!key) return first.modelID;
    const model = provider.models[key];
    if (!model) throw new Error(`unknown model key "${key}" for ${tier} tier`);
    return model.modelID;
  }

  const [, second = first, third = second] = models;
  return tier === 'subagent' ? second.modelID : third.modelID;
}

export function buildSubagentPolicy(
  providerId: string,
  parentModelId: string,
  provider: Pick<ProviderDef, 'models' | 'aliases' | 'agents'>,
): OrchestrelSubagentPolicy {
  const agents: Record<string, AgentPolicy> = {};

  for (const [name, tier] of Object.entries(DEFAULT_TIERS)) {
    const modelId = modelForTier(tier, provider);
    if (modelId) agents[name] = { model: `${providerId}/${modelId}`, source: `${tier} tier` };
  }
  agents.Plan = { model: `${providerId}/${parentModelId}`, source: 'parent model' };

  for (const [name, key] of Object.entries(provider.agents ?? {})) {
    const model = provider.models[key];
    if (!model) throw new Error(`unknown model key "${key}" for agent "${name}"`);
    agents[name] = { model: `${providerId}/${model.modelID}`, source: 'agent override' };
  }

  return {
    parentProvider: providerId,
    parentModel: `${providerId}/${parentModelId}`,
    agents,
    allowCrossProvider: false,
  };
}

export function serializeSubagentPolicy(policy: OrchestrelSubagentPolicy): string {
  return JSON.stringify(parseSubagentPolicy(JSON.stringify(policy)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSubagentPolicy(value: string): OrchestrelSubagentPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('invalid Orchestrel subagent policy JSON');
  }
  if (!isRecord(parsed)) throw new Error('invalid Orchestrel subagent policy');
  if (typeof parsed.parentProvider !== 'string' || !parsed.parentProvider) {
    throw new Error('subagent policy parentProvider must be a non-empty string');
  }
  if (typeof parsed.parentModel !== 'string' || !parsed.parentModel) {
    throw new Error('subagent policy parentModel must be a non-empty string');
  }
  if (parsed.allowCrossProvider !== false) throw new Error('allowCrossProvider must be false');
  if (!isRecord(parsed.agents)) throw new Error('subagent policy agents must be an object');

  const agents: Record<string, AgentPolicy> = {};
  for (const [name, agent] of Object.entries(parsed.agents)) {
    if (!isRecord(agent) || typeof agent.model !== 'string' || !agent.model || typeof agent.source !== 'string' || !agent.source) {
      throw new Error(`subagent policy agent "${name}" must have non-empty model and source strings`);
    }
    agents[name] = { model: agent.model, source: agent.source };
  }

  return {
    parentProvider: parsed.parentProvider,
    parentModel: parsed.parentModel,
    agents,
    allowCrossProvider: false,
  };
}

/** Remove only legacy Orchestrel-generated agent overrides, never user Pi files. */
export function cleanupManagedSubagentFiles(cwd: string): void {
  try {
    const piDir = join(cwd, '.pi');
    const agentsDir = join(piDir, 'agents');
    if (!existsSync(agentsDir)) return;

    for (const file of readdirSync(agentsDir)) {
      if (!file.endsWith('.md')) continue;
      const path = join(agentsDir, file);
      if (readFileSync(path, 'utf-8').includes(MANAGED_MARKER)) rmSync(path);
    }

    if (readdirSync(agentsDir).length !== 0) return;
    rmdirSync(agentsDir);
    if (existsSync(piDir) && readdirSync(piDir).length === 0) rmdirSync(piDir);
  } catch (err) {
    console.warn(`[orcd] failed to clean legacy managed subagent files in ${cwd}:`, err);
  }
}
