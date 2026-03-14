type Model = 'sonnet' | 'opus' | 'auto'
type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

interface ResolvedModel {
  modelID: string
  variant?: string
}

const BASE_MODEL: Record<Model, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  auto: 'auto',
}

export function resolveModel(
  _provider: string,
  model: Model = 'sonnet',
  thinkingLevel: ThinkingLevel = 'high',
): ResolvedModel {
  return {
    modelID: BASE_MODEL[model] ?? BASE_MODEL.sonnet,
    variant: thinkingLevel === 'off' ? undefined : thinkingLevel,
  }
}
