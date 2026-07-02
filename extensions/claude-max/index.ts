import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { claudeMaxOAuth } from './auth';
import { makeClaudeCodeStream } from './stream';

// The provider name the extension augments. Must match the provider id orchestrel
// registers from config.yaml for the Claude Max provider.
const PROVIDER_NAME = process.env.ORCHESTREL_CLAUDE_MAX_PROVIDER ?? 'anthropic';

const extension: ExtensionFactory = (pi) => {
  pi.registerProvider(PROVIDER_NAME, {
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    // Placeholder to satisfy Pi's pre-prompt auth gate (_getRequiredRequestAuth
    // requires a truthy apiKey or stored oauth creds). streamSimple performs the
    // real Claude Max OAuth via getAccessToken and ignores this value.
    apiKey: 'claude-max-oauth',
    oauth: claudeMaxOAuth,
    streamSimple: makeClaudeCodeStream(PROVIDER_NAME),
    // No `models`: augments orchestrel's catalog (verified in Task 0 spike).
  });
};

export default extension;
