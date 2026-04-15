import { parse as parseYaml } from 'yaml';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  authToken?: string;
  models: string[];
}

export interface MemoryUpsertConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
}

export interface OrcdConfig {
  socket: string;
  defaultProvider: string;
  defaultModel: string;
  defaultCwd?: string;
  providers: Record<string, ProviderConfig>;
  memoryUpsert?: MemoryUpsertConfig;
}

/**
 * Replace ${VAR} patterns with values from env.
 * Unset vars become empty string.
 */
export function resolveEnvVars(str: string, env: Record<string, string | undefined>): string {
  return str.replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? '');
}

/**
 * Parse YAML config string into validated OrcdConfig.
 * Resolves env var interpolation in all string values.
 */
export function parseConfig(yamlStr: string, env: Record<string, string | undefined>): OrcdConfig {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;

  if (!raw.providers || typeof raw.providers !== 'object') {
    throw new Error('config: "providers" section is required');
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [name, p] of Object.entries(raw.providers as Record<string, Record<string, unknown>>)) {
    if (!p.baseUrl || !p.models) {
      throw new Error(`config: provider "${name}" requires baseUrl and models`);
    }
    providers[name] = {
      baseUrl: resolveEnvVars(String(p.baseUrl), env),
      apiKey: resolveEnvVars(String(p.apiKey ?? ''), env),
      ...(p.authToken ? { authToken: resolveEnvVars(String(p.authToken), env) } : {}),
      models: (p.models as string[]).map(String),
    };
  }

  const mu = raw.memoryUpsert as Record<string, unknown> | undefined;
  const memoryUpsert: MemoryUpsertConfig | undefined = mu
    ? {
        enabled: Boolean(mu.enabled ?? false),
        baseUrl: resolveEnvVars(String(mu.baseUrl ?? 'http://localhost:3100'), env),
        apiKey: resolveEnvVars(String(mu.apiKey ?? ''), env),
      }
    : undefined;

  return {
    socket: String(raw.socket ?? '~/.orc/orcd.sock'),
    defaultProvider: String(raw.defaultProvider ?? 'anthropic'),
    defaultModel: String(raw.defaultModel ?? 'claude-sonnet-4-6'),
    defaultCwd: raw.defaultCwd != null ? String(raw.defaultCwd) : undefined,
    providers,
    memoryUpsert,
  };
}

/**
 * Load config from ~/.orc/config.yaml.
 */
export async function loadConfig(): Promise<OrcdConfig> {
  const { readFile } = await import('fs/promises');
  const { homedir } = await import('os');
  const path = `${homedir()}/.orc/config.yaml`;
  const content = await readFile(path, 'utf-8');
  return parseConfig(content, process.env as Record<string, string | undefined>);
}
