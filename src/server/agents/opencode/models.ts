import { getModelConfig } from '../../config/providers';

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

interface ResolvedModel {
  modelID: string;
  variant?: string;
}

export function resolveModel(
  provider: string,
  model: string = 'sonnet',
  thinkingLevel: ThinkingLevel = 'high',
): ResolvedModel {
  const cfg = getModelConfig(provider, model);
  const modelID = cfg?.modelID ?? 'claude-sonnet-4-6';

  return {
    modelID,
    variant: thinkingLevel === 'off' ? undefined : thinkingLevel,
  };
}
