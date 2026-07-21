/**
 * subagent-agents.ts — Maps orcd.yaml provider model tiers onto pi-subagents.
 *
 * Pi subagents run in-process against the session's ModelRegistry; there is no
 * env-var tier system like the Claude Agent SDK had. pi-subagents picks a
 * subagent model from (1) agent .md frontmatter, (2) the Agent tool's `model`
 * param, (3) parent-session inherit. The embedded Explore agent pins
 * `anthropic/claude-haiku-4-5`, which fails on non-anthropic providers — so
 * orcd writes per-cwd `.pi/agents/<Name>.md` overrides pinning each agent to a
 * model from the session's provider.
 *
 * Effective mapping (agent name → model key):
 *   defaults:  general-purpose → subagent tier (slot 2 / old sonnet equiv)
 *              Explore         → lightweight tier (slot 3 / old haiku equiv)
 *   overrides: the provider's `agents:` map in orcd.yaml, per agent name
 * Tiers resolve via `aliases.subagent` / `aliases.lightweight` when present,
 * else positionally from the models map.
 *
 * Files carry a `managed_by: orchestrel` frontmatter marker; user-authored
 * files without the marker are never touched, and stale managed files whose
 * agent is no longer mapped are removed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ModelDef } from '../shared/config';

export interface ProviderAliases {
  subagent?: string;
  lightweight?: string;
}

export interface AgentModelConfig {
  models: Record<string, ModelDef>;
  aliases?: ProviderAliases;
  agents?: Record<string, string>;
}

const MANAGED_MARKER = 'managed_by: orchestrel';

type Tier = 'subagent' | 'lightweight';

/**
 * Resolve a tier's modelID. Alias mode (aliases block present, even empty):
 * the tier's key → modelID, falling back to the first model. Positional mode:
 * subagent → 2nd model, lightweight → 3rd (each falling back to the previous).
 */
export function resolveTierModelId(
  models: Record<string, ModelDef>,
  aliases: ProviderAliases | undefined,
  tier: Tier,
): string | undefined {
  const ids = Object.values(models).map((m) => m.modelID);
  const first = ids[0];
  if (!first) {
    console.warn(`[orcd] resolveTierModelId: provider has no models, cannot resolve ${tier} tier`);
    return undefined;
  }
  let result: string;
  if (aliases) {
    const key = aliases[tier];
    result = (key ? models[key]?.modelID : undefined) ?? first;
  } else {
    const [, second = first, third = second] = ids;
    result = tier === 'subagent' ? second : third;
  }
  return result;
}

const READ_ONLY_TOOLS = 'read, bash, grep, find, ls';

// Templates mirror pi-subagents' embedded defaults (default-agents.ts) — a
// user .md file fully replaces a same-named default, so managed overrides must
// carry the complete agent definition with only the model swapped.
const AGENT_TEMPLATES: Record<string, { frontmatter: string; body: string }> = {
  'general-purpose': {
    frontmatter: `description: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.
prompt_mode: append`,
    body: '',
  },
  Explore: {
    frontmatter: `description: >-
  Fast read-only search agent for locating code. Use it to find files by pattern (eg. "src/components/**/*.tsx"), grep for symbols or keywords (eg. "API endpoints"), or answer "where is X defined / which files reference Y." Do NOT use it for code review, design-doc auditing, cross-file consistency checks, or open-ended analysis — it reads excerpts rather than whole files and will miss content past its read window. When calling, specify search breadth: "quick" for a single targeted lookup, "medium" for moderate exploration, or "very thorough" to search across multiple locations and naming conventions.
tools: ${READ_ONLY_TOOLS}`,
    body: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
- Make independent tool calls in parallel for efficiency
- Adapt search approach based on thoroughness level specified

# Output
- Use absolute file paths in all references
- Report findings as regular messages
- Do not use emojis
- Be thorough and precise`,
  },
  Plan: {
    frontmatter: `description: Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.
tools: ${READ_ONLY_TOOLS}`,
    body: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a software architect and planning specialist.
Your role is EXCLUSIVELY to explore the codebase and design implementation plans.
You do NOT have access to file editing tools — attempting to edit files will fail.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.

# Planning Process
1. Understand requirements
2. Explore thoroughly (read files, find patterns, understand architecture)
3. Design solution based on your assigned perspective
4. Detail the plan with step-by-step implementation strategy

# Requirements
- Consider trade-offs and architectural decisions
- Identify dependencies and sequencing
- Anticipate potential challenges
- Follow existing patterns where appropriate

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations

# Output Format
- Use absolute file paths
- Do not use emojis
- End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- /absolute/path/to/file.ts - [Brief reason]`,
  },
};

/**
 * Effective agent → modelID map for a provider: tier defaults overridden by
 * the granular `agents:` config. Unknown agent names (no embedded default to
 * mirror) and unknown model keys are skipped with a warning.
 */
export function effectiveAgentModels(cfg: AgentModelConfig): Map<string, string> {
  const map = new Map<string, string>();
  const subagent = resolveTierModelId(cfg.models, cfg.aliases, 'subagent');
  const lightweight = resolveTierModelId(cfg.models, cfg.aliases, 'lightweight');
  if (subagent) map.set('general-purpose', subagent);
  if (lightweight) map.set('Explore', lightweight);

  for (const [name, key] of Object.entries(cfg.agents ?? {})) {
    if (!AGENT_TEMPLATES[name]) {
      console.warn(`[orcd] agents config: unknown agent "${name}" (known: ${Object.keys(AGENT_TEMPLATES).join(', ')}), skipping`);
      continue;
    }
    const modelId = cfg.models[key]?.modelID ?? Object.values(cfg.models)[0]?.modelID;
    if (!modelId) continue;
    if (!cfg.models[key]) {
      console.warn(`[orcd] agents config: unknown model key "${key}" for agent "${name}", using first model`);
    }
    map.set(name, modelId);
  }
  return map;
}

function agentMarkdown(name: string, providerId: string, modelId: string): string {
  const t = AGENT_TEMPLATES[name];
  const body = t?.body ? `\n${t.body}\n` : '';
  return `---\n${t?.frontmatter}\nmodel: ${providerId}/${modelId}\n${MANAGED_MARKER}\n---${body}`;
}

/**
 * Sync `<cwd>/.pi/agents/` managed overrides with the provider's effective
 * agent → model map. Never touches user-authored (unmarked) files; removes
 * stale managed files for agents no longer mapped. Never throws — a read-only
 * cwd must not break session creation.
 */
export function syncAgentOverrides(cwd: string, providerId: string, cfg: AgentModelConfig): void {
  try {
    const effective = effectiveAgentModels(cfg);
    const dir = join(cwd, '.pi', 'agents');

    for (const [name, modelId] of effective) {
      const content = agentMarkdown(name, providerId, modelId);
      const path = join(dir, `${name}.md`);
      if (existsSync(path)) {
        const existing = readFileSync(path, 'utf-8');
        if (existing === content) continue;
        if (!existing.includes(MANAGED_MARKER)) continue;
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, content);
    }

    if (!existsSync(dir)) {
      console.log(`[orcd] no .pi/agents dir in ${cwd}, nothing to clean up`);
      return;
    }
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -3);
      if (effective.has(name)) continue;
      const path = join(dir, file);
      const content = readFileSync(path, 'utf-8');
      if (content.includes(MANAGED_MARKER)) rmSync(path);
    }
  } catch (err) {
    console.warn(`[orcd] failed to sync agent overrides in ${cwd}:`, err);
  }
}
