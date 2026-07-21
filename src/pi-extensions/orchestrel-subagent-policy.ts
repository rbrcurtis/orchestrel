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
  if (req.requestedModel !== undefined && (typeof req.requestedModel !== 'string' || !req.requestedModel)) {
    throw new Error('subagent model policy request requestedModel must be a non-empty string');
  }

  return req as unknown as SubagentModelPolicyRequest;
}

function register(pi: ExtensionAPI, policy: OrchestrelSubagentPolicy): void {
  const unsubscribe = pi.events.on('subagents:model-policy', (raw) => {
    const req = validateRequest(raw);
    if (req.decision) return;

    if (req.parentProvider !== policy.parentProvider) {
      req.decision = {
        error: `Subagent policy provider "${policy.parentProvider}" does not match parent provider "${req.parentProvider}".`,
      };
      return;
    }

    if (req.requestedModel) {
      const slash = req.requestedModel.indexOf('/');
      const provider = slash > 0 ? req.requestedModel.slice(0, slash) : '';
      req.decision = provider === policy.parentProvider
        ? { model: req.requestedModel, source: 'explicit' }
        : {
          error: `Subagent model "${req.requestedModel}" is not allowed. This session uses provider "${policy.parentProvider}".`,
        };
      return;
    }

    req.decision = policy.agents[req.agentType] ?? {
      model: policy.parentModel,
      source: 'parent model',
    };
  });

  pi.on('session_shutdown', () => unsubscribe());
}

export function createOrchestrelSubagentPolicyExtension(
  policy: OrchestrelSubagentPolicy,
): ExtensionFactory {
  return (pi) => register(pi, policy);
}

export default function orchestrelSubagentPolicyFromEnv(pi: ExtensionAPI): void {
  const value = process.env[ORCHESTREL_SUBAGENT_POLICY_ENV];
  if (!value) throw new Error(`Missing ${ORCHESTREL_SUBAGENT_POLICY_ENV}`);
  register(pi, parseSubagentPolicy(value));
}
