import type { Api } from '@earendil-works/pi-ai';
import type { ProviderType } from './config';

export function providerApi(type: ProviderType | undefined): Api {
  if (type === 'bedrock') return 'bedrock-converse-stream';
  if (type === 'google') return 'google-generative-ai';
  if (type === 'openai') return 'openai-completions';
  return 'anthropic-messages';
}
