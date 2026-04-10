import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';

const CLAUDE_DIR = join(homedir(), '.claude');
const PLUGINS_CACHE = join(CLAUDE_DIR, 'plugins', 'cache');

/**
 * Parse a prompt starting with / into command name + arguments.
 * Returns null if the prompt doesn't start with /.
 */
export function parseSlashCommand(prompt: string): { name: string; args: string } | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith('/')) return null;

  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1), args: '' };
  }
  return {
    name: trimmed.slice(1, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

/**
 * Parse arguments respecting shell-style quoting.
 * "multi word" arg2 → ["multi word", "arg2"]
 */
function parseArgs(args: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        result.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) result.push(current);
  return result;
}

/**
 * Resolve a skill name to its SKILL.md file path.
 *
 * Resolution order:
 * 1. Namespaced (plugin:skill) — specific plugin's skills dir
 * 2. Project-level — <cwd>/.claude/skills/<name>/SKILL.md
 * 3. User-level — ~/.claude/skills/<name>/SKILL.md
 * 4. Plugin skills — ~/.claude/plugins/cache/ (**\/skills/<name>/SKILL.md)
 * 5. Legacy commands — <cwd>/.claude/commands/<name>.md, ~/.claude/commands/<name>.md
 */
export function resolveSkillPath(name: string, cwd: string): string | null {
  // 1. Namespaced: "plugin:skill"
  if (name.includes(':')) {
    const [pluginName, skillName] = name.split(':', 2);
    const path = findPluginSkill(pluginName, skillName);
    if (path) return path;
    return null;
  }

  // 2. Project-level
  const projectPath = join(cwd, '.claude', 'skills', name, 'SKILL.md');
  if (existsSync(projectPath)) return projectPath;

  // 3. User-level
  const userPath = join(CLAUDE_DIR, 'skills', name, 'SKILL.md');
  if (existsSync(userPath)) return userPath;

  // 4. Plugin skills (scan all installed plugins)
  const pluginPath = findAnyPluginSkill(name);
  if (pluginPath) return pluginPath;

  // 5. Legacy commands
  const projectCmd = join(cwd, '.claude', 'commands', `${name}.md`);
  if (existsSync(projectCmd)) return projectCmd;

  const userCmd = join(CLAUDE_DIR, 'commands', `${name}.md`);
  if (existsSync(userCmd)) return userCmd;

  return null;
}

/**
 * Find a skill within a specific plugin by name.
 */
function findPluginSkill(pluginName: string, skillName: string): string | null {
  if (!existsSync(PLUGINS_CACHE)) return null;

  for (const registry of safeReaddir(PLUGINS_CACHE)) {
    const registryPath = join(PLUGINS_CACHE, registry);
    if (!isDir(registryPath)) continue;

    const pluginDir = join(registryPath, pluginName);
    if (!isDir(pluginDir)) continue;

    for (const version of safeReaddir(pluginDir)) {
      const skillPath = join(pluginDir, version, 'skills', skillName, 'SKILL.md');
      if (existsSync(skillPath)) return skillPath;
    }
  }
  return null;
}

/**
 * Find a skill by name across all installed plugins.
 */
function findAnyPluginSkill(skillName: string): string | null {
  if (!existsSync(PLUGINS_CACHE)) return null;

  for (const registry of safeReaddir(PLUGINS_CACHE)) {
    const registryPath = join(PLUGINS_CACHE, registry);
    if (!isDir(registryPath)) continue;

    for (const plugin of safeReaddir(registryPath)) {
      const pluginDir = join(registryPath, plugin);
      if (!isDir(pluginDir)) continue;

      for (const version of safeReaddir(pluginDir)) {
        const skillPath = join(pluginDir, version, 'skills', skillName, 'SKILL.md');
        if (existsSync(skillPath)) return skillPath;
      }
    }
  }
  return null;
}

/**
 * Strip YAML frontmatter from skill content.
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('---', 3);
  if (end === -1) return content;
  return content.slice(end + 3).trimStart();
}

/**
 * Execute inline shell blocks: !`command` → command output.
 * Commands come from trusted SKILL.md files (user config), not user input.
 */
function executeShellBlocks(content: string, cwd: string): string {
   
  return content.replace(/!`([^`]+)`/g, (_match, cmd: string) => {
    try {
      return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 10_000 }).trim();
    } catch {
      return `[shell error: ${cmd}]`;
    }
  });
}

/**
 * Render a skill's content with argument substitution and shell execution.
 */
export function renderSkill(
  raw: string,
  args: string,
  cwd: string,
  skillDir: string,
): string {
  let content = stripFrontmatter(raw);

  const positional = parseArgs(args);

  // Shell execution blocks (before variable substitution to avoid injecting args into commands)
  content = executeShellBlocks(content, cwd);

  // Variable substitution
  content = content.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir);

  // $ARGUMENTS — if not present in content, append it
  const hasArgRef = /\$ARGUMENTS/.test(content);
  content = content.replace(/\$ARGUMENTS/g, args);

  // Positional: $0, $1, $2, etc.
  const hasPositionalRef = /\$\d/.test(content);
  for (let i = 0; i < positional.length; i++) {
    content = content.replace(new RegExp(`\\$${i}`, 'g'), positional[i]);
  }

  if (!hasArgRef && !hasPositionalRef && args) {
    content += `\n\nARGUMENTS: ${args}`;
  }

  return content;
}

/**
 * Expand a slash command in a prompt to its rendered skill content.
 * Returns the original prompt if no skill is found.
 */
export function expandSlashCommand(prompt: string, cwd: string): string {
  const parsed = parseSlashCommand(prompt);
  if (!parsed) return prompt;

  const skillPath = resolveSkillPath(parsed.name, cwd);
  if (!skillPath) return prompt;

  const raw = readFileSync(skillPath, 'utf-8');
  const skillDir = dirname(skillPath);
  const rendered = renderSkill(raw, parsed.args, cwd, skillDir);

  console.log(`[orcd:skill] expanded /${parsed.name} from ${skillPath}`);
  return rendered;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
