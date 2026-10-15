import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, realpathSync } from 'fs';
import { parseDocument, type Document } from 'yaml';
import { configPath } from '../shared/config';
import { parseConfig, type OrcdConfig } from './config';

export interface RawProviderMap {
  [id: string]: Record<string, unknown>;
}

export interface ProviderFileSnapshot {
  configPath: string;
  providers: RawProviderMap;
  defaultProvider: string;
  defaultModel: string;
}

export interface ProviderFileInput {
  providers: RawProviderMap;
  defaultProvider: string;
  defaultModel: string;
}

/**
 * The config file lives on the node that runs from it, and `config.yaml` is a
 * symlink to `orcd.yaml` on the boxes that predate the rename. Every write
 * resolves the real path first: a tmp+rename onto the symlink path would replace
 * the link with a regular file and orphan the config it pointed at.
 */
function realConfigPath(): string {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(`No config file at ${path} — a node cannot edit providers without one.`);
  }
  return realpathSync(path);
}

function readDocument(): { doc: Document; path: string } {
  const path = realConfigPath();
  const doc = parseDocument(readFileSync(path, 'utf8'));
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0]!.message}`);
  return { doc, path };
}

function rawMap(value: unknown): RawProviderMap {
  return value && typeof value === 'object' ? (value as RawProviderMap) : {};
}

/**
 * Raw (unresolved) provider definitions, as written in the file. The parsed
 * config resolves `${ENV_VAR}` templates, so returning that instead would write
 * the resolved secrets back as plaintext on the next save.
 */
export function readProviderFile(): ProviderFileSnapshot {
  const { doc, path } = readDocument();
  // toJS(), not get(): get() returns the YAML node for a mapping, which has no
  // own keys, so a caller reading providers[id] would see undefined.
  const plain = (doc.toJS() ?? {}) as Record<string, unknown>;
  return {
    configPath: path,
    providers: rawMap(plain.providers),
    defaultProvider: String(plain.defaultProvider ?? ''),
    defaultModel: String(plain.defaultModel ?? ''),
  };
}

/**
 * Everything the runtime needs from a provider map, checked before the file is
 * touched — a rejected save leaves the previous config in place. The parsed
 * config is returned so the caller can swap its in-memory providers without
 * reading the file again.
 */
export function saveProviderFile(input: ProviderFileInput): ProviderFileSnapshot & { config: OrcdConfig } {
  const problems = validateProviders(input);
  if (problems.length > 0) throw new Error(problems.join('\n'));

  const { doc, path } = readDocument();
  doc.set('providers', input.providers);
  doc.set('defaultProvider', input.defaultProvider);
  doc.set('defaultModel', input.defaultModel);
  const text = doc.toString();
  // The same parser the daemon boots with: a file that saves is a file that loads.
  const config = parseConfig(text, process.env);
  writeAtomic(path, text);

  return {
    configPath: path,
    providers: input.providers,
    defaultProvider: input.defaultProvider,
    defaultModel: input.defaultModel,
    config,
  };
}

// A rename keeps the temp file's mode, so an existing config keeps the
// permissions its owner chose; a new one is created private (it holds API keys).
function writeAtomic(path: string, text: string): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  try {
    renameSync(tmp, path);
  } catch (err) {
    console.error(`[orcd] provider config: could not replace ${path}:`, err instanceof Error ? err.message : err);
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function validateProviders(input: ProviderFileInput): string[] {
  const problems: string[] = [];
  const ids = Object.keys(input.providers ?? {});

  for (const id of ids) {
    const p = input.providers[id];
    if (!p || typeof p !== 'object') {
      problems.push(`Provider "${id}" must be a map of settings.`);
      continue;
    }
    if (!/^[A-Za-z0-9][\w.-]*$/.test(id)) {
      problems.push(`Provider id "${id}" must start with a letter or digit and contain no spaces.`);
    }

    const models = rawMap(p.models);
    const aliases = Object.keys(models);
    if (aliases.length === 0) {
      problems.push(`Provider "${id}" needs at least one model — the board's model dropdown is built from them.`);
    }
    for (const alias of aliases) {
      const m = models[alias];
      if (!m || typeof m !== 'object' || !String(m.modelID ?? '').trim()) {
        problems.push(`Provider "${id}" model "${alias}" needs a modelID.`);
      }
      const ctx = Number(m?.contextWindow);
      if (m?.contextWindow != null && (!Number.isFinite(ctx) || ctx <= 0)) {
        problems.push(`Provider "${id}" model "${alias}" needs a positive contextWindow (got "${String(m.contextWindow)}").`);
      }
    }

    if (!p.oauth && !String(p.baseUrl ?? '').trim()) {
      problems.push(`Provider "${id}" needs a baseUrl, or an "oauth" extension name instead.`);
    }

    const tierRefs = rawMap(p.aliases);
    for (const [tier, ref] of Object.entries(tierRefs)) {
      if (!aliases.includes(String(ref))) {
        problems.push(
          `Provider "${id}" ${tier} tier points at model "${String(ref)}", which it does not define (${aliases.join(', ') || 'none'}).`,
        );
      }
    }
    for (const [agent, ref] of Object.entries(rawMap(p.agents))) {
      if (!aliases.includes(String(ref))) {
        problems.push(
          `Provider "${id}" agent "${agent}" points at model "${String(ref)}", which it does not define (${aliases.join(', ') || 'none'}).`,
        );
      }
    }
  }

  if (ids.length > 0) {
    if (!ids.includes(input.defaultProvider)) {
      problems.push(`Default provider "${input.defaultProvider}" is not one of the configured providers (${ids.join(', ')}).`);
    } else {
      const aliases = Object.keys(rawMap(input.providers[input.defaultProvider]?.models));
      if (!aliases.includes(input.defaultModel)) {
        problems.push(
          `Default model "${input.defaultModel}" is not one of "${input.defaultProvider}"'s models (${aliases.join(', ') || 'none'}).`,
        );
      }
    }
  }

  return problems;
}

/**
 * Provider-agnostic reachability check: orcd has no provider-specific code, so
 * this only asks whether anything answers at the baseUrl. Any HTTP status counts
 * as reachable (401/404 still prove a server is there); a refusal or DNS failure
 * is the failure that actually happens — a local proxy that is not running.
 */
export async function testProviderEndpoint(baseUrl: string): Promise<{ ok: boolean; detail: string }> {
  const url = String(baseUrl ?? '').trim();
  if (!url) {
    console.warn('[orcd] provider_test: no baseUrl to probe');
    return { ok: false, detail: 'This provider has no baseUrl to test.' };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'manual' });
    console.log(`[orcd] provider_test: ${url} answered HTTP ${res.status}`);
    return { ok: true, detail: `Reachable — HTTP ${res.status} from ${url}.` };
  } catch (err) {
    console.warn(`[orcd] provider_test: nothing answered at ${url}:`, err instanceof Error ? err.message : err);
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `Nothing answered at ${url} (${reason}). Check the host and port, and that the proxy is running.` };
  }
}
