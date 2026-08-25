import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import {
  parseSubagentPolicy,
  type OrchestrelSubagentPolicy,
} from '../shared/subagent-policy';

export const ORCHESTREL_SUBAGENT_POLICY_ENV = 'ORCHESTREL_SUBAGENT_POLICY';

interface SubagentModelPolicyRequest {
  agentType: string;
  requestedModel?: string;
  parentProvider: string;
  parentModel: string;
  decision?: unknown;
}

function validateRequest(raw: unknown): SubagentModelPolicyRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid subagent model policy request');
  }

  const req = raw as Record<string, unknown>;
  if (typeof req.agentType !== 'string' || !req.agentType) {
    throw new Error('subagent model policy request agentType must be a non-empty string');
  }
  if (typeof req.parentProvider !== 'string' || !req.parentProvider) {
    throw new Error('subagent model policy request parentProvider must be a non-empty string');
  }
  if (typeof req.parentModel !== 'string' || !req.parentModel) {
    throw new Error('subagent model policy request parentModel must be a non-empty string');
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(req.parentModel)) {
    throw new Error('subagent model policy request parentModel must be a fully qualified provider/modelID');
  }
  const [provider] = req.parentModel.split('/');
  if (provider !== req.parentProvider) {
    throw new Error(`subagent model policy request parentModel provider must equal parentProvider "${req.parentProvider}"`);
  }
  if (req.requestedModel !== undefined && (typeof req.requestedModel !== 'string' || !req.requestedModel)) {
    throw new Error('subagent model policy request requestedModel must be a non-empty string');
  }

  return req as unknown as SubagentModelPolicyRequest;
}

export interface OrchestrelSubagentPolicyExtensionOptions {
  onDecision?: (input: {
    agentType: string;
    decision: { model: string; source: string } | { error: string };
  }) => void;
}

function notifyDecision(
  onDecision: OrchestrelSubagentPolicyExtensionOptions['onDecision'],
  agentType: string,
  decision: unknown,
): void {
  if (!onDecision || !decision || typeof decision !== 'object') return;
  const value = decision as Record<string, unknown>;
  if (typeof value.model === 'string' && typeof value.source === 'string') {
    onDecision({ agentType, decision: { model: value.model, source: value.source } });
  } else if (typeof value.error === 'string') {
    onDecision({ agentType, decision: { error: value.error } });
  }
}

function register(
  pi: ExtensionAPI,
  policy: OrchestrelSubagentPolicy,
  opts: OrchestrelSubagentPolicyExtensionOptions = {},
): void {
  const unsubscribe = pi.events.on('subagents:model-policy', (raw) => {
    const req = validateRequest(raw);
    if (req.decision) return;

    if (req.parentProvider !== policy.parentProvider) {
      req.decision = {
        error: `Subagent policy provider "${policy.parentProvider}" does not match parent provider "${req.parentProvider}".`,
      };
      notifyDecision(opts.onDecision, req.agentType, req.decision);
      return;
    }

    if (req.requestedModel) {
      const slash = req.requestedModel.indexOf('/');
      const provider = slash > 0 ? req.requestedModel.slice(0, slash) : policy.parentProvider;
      const modelId = slash > 0 ? req.requestedModel.slice(slash + 1) : req.requestedModel;
      // Accept both qualified and bare names, but only models this session's
      // provider actually offers — the LLM sometimes drops the provider
      // prefix or invents model ids.
      req.decision = provider === policy.parentProvider && policy.parentModels.includes(modelId)
        ? { model: `${policy.parentProvider}/${modelId}`, source: 'explicit' }
        : {
          error: `Subagent model "${req.requestedModel}" is not allowed. This session uses provider "${policy.parentProvider}".`,
        };
      notifyDecision(opts.onDecision, req.agentType, req.decision);
      return;
    }

    req.decision = policy.agents[req.agentType] ?? {
      model: policy.parentModel,
      source: 'parent model',
    };
    notifyDecision(opts.onDecision, req.agentType, req.decision);
  });

  pi.on('session_shutdown', () => unsubscribe());
}

export function createOrchestrelSubagentPolicyExtension(
  policy: OrchestrelSubagentPolicy,
  opts?: OrchestrelSubagentPolicyExtensionOptions,
): ExtensionFactory {
  return (pi) => register(pi, policy, opts);
}

export default function orchestrelSubagentPolicyFromEnv(pi: ExtensionAPI): void {
  const value = process.env[ORCHESTREL_SUBAGENT_POLICY_ENV];
  if (!value) throw new Error(`Missing ${ORCHESTREL_SUBAGENT_POLICY_ENV}`);
  register(pi, parseSubagentPolicy(value));
}
