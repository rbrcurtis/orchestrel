import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { resolveEnvVars } from '../../shared/config';

export interface NodeEntry {
  name: string;
  host: string;
  port: number;
  authToken: string;
}

export function parseNodeRegistry(yamlStr: string, env: Record<string, string | undefined>): NodeEntry[] {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;
  if (!Array.isArray(raw.servers)) throw new Error('orc.yaml: "servers" must be an array');
  return (raw.servers as Record<string, unknown>[]).map((s) => ({
    name: String(s.name),
    host: String(s.host),
    port: Number(s.port),
    authToken: s.authToken != null ? resolveEnvVars(String(s.authToken), env) : '',
  }));
}

export function nodeRegistryPath(): string {
  return process.env.ORC_NODES ?? resolve(process.cwd(), 'orc.yaml');
}

let cached: NodeEntry[] | null = null;

export function loadNodeRegistry(): NodeEntry[] {
  if (cached) { console.log('[nodes] returning cached node registry'); return cached; }
  const path = nodeRegistryPath();
  if (!existsSync(path)) throw new Error(`orc.yaml not found at ${path}`);
  cached = parseNodeRegistry(readFileSync(path, 'utf-8'), process.env as Record<string, string | undefined>);
  return cached;
}

export function resetNodeRegistryCache(): void { cached = null; }
