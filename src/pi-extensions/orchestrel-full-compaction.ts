import { compact, type ExtensionFactory, type ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';

export interface FullCompactionExtensionOptions {
  modelRegistry: ModelRegistry;
  model: Model<Api>;
  timeoutMs: number;
}

export function createOrchestrelFullCompactionExtension(
  opts: FullCompactionExtensionOptions,
): ExtensionFactory {
  return (pi) => {
    pi.on('session_before_compact', async (event) => {
      if (event.reason !== 'manual') return;

      try {
        const auth = await opts.modelRegistry.getApiKeyAndHeaders(opts.model);
        if (!auth.ok) throw new Error(auth.error);

        const timeout = AbortSignal.timeout(opts.timeoutMs);
        const signal = AbortSignal.any([event.signal, timeout]);
        const result = await compact(
          event.preparation,
          opts.model,
          auth.apiKey,
          auth.headers,
          event.customInstructions,
          signal,
          'off',
          undefined,
          auth.env,
        );
        if (!result.summary.trim()) throw new Error('Compaction model returned an empty summary');
        return { compaction: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orcd:compact] local compaction failed: ${message}`);
        return { cancel: true };
      }
    });
  };
}
