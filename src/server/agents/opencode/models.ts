type Model = 'sonnet' | 'opus'
type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

const MODEL_MAP: Record<Model, Record<ThinkingLevel, string>> = {
  sonnet: {
    off: 'claude-sonnet-4-6',
    low: 'claude-sonnet-4-6-thinking',
    medium: 'claude-sonnet-4-6-thinking',
    high: 'claude-sonnet-4-6-thinking',
  },
  opus: {
    off: 'claude-opus-4-6',
    low: 'claude-opus-4-6-thinking',
    medium: 'claude-opus-4-6-thinking',
    high: 'claude-opus-4-6-thinking',
  },
}

export function resolveModelID(
  model: Model = 'sonnet',
  thinkingLevel: ThinkingLevel = 'high',
): string {
  return MODEL_MAP[model]?.[thinkingLevel] ?? MODEL_MAP.sonnet.high
}
