import { parse as parseYaml } from 'yaml';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  authToken?: string;
  models: string[];
}

export interface OrcdConfig {
  socket: string;
  defaultProvider: string;
  defaultModel: string;
  defaultCwd?: string;
  providers: Record<string, ProviderConfig>;
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

  return {
    socket: String(raw.socket ?? '~/.orc/orcd.sock'),
    defaultProvider: String(raw.defaultProvider ?? 'anthropic'),
    defaultModel: String(raw.defaultModel ?? 'claude-sonnet-4-6'),
    defaultCwd: raw.defaultCwd != null ? String(raw.defaultCwd) : undefined,
    providers,
  };
}

/**
 * Load config from ~/.orc/config.yaml (or ORC_CONFIG env var).
 */
export async function loadConfig(): Promise<OrcdConfig> {
  const { readFile } = await import('fs/promises');
  const { homedir } = await import('os');
  const path = process.env.ORC_CONFIG ?? `${homedir()}/.orc/config.yaml`;
  const resolved = path.replace(/^~/, homedir());
  const content = await readFile(resolved, 'utf-8');
  return parseConfig(content, process.env as Record<string, string | undefined>);
}
