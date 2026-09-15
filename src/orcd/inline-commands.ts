/* oxlint-disable orchestrel/log-before-early-return -- pure string-command expansion: early returns are no-op fast-paths and mapped string transforms without session context */
import { readFileSync } from 'fs';
import { stripFrontmatter } from '@earendil-works/pi-coding-agent';
import type { AgentSession, PromptTemplate } from '@earendil-works/pi-coding-agent';
import { INJECTED_COMMANDS_MARKER, maskCodeRegions } from '../shared/slash-commands';

// Orchestrel-only: Pi expands a skill/prompt slash-command ONLY when it is the
// first thing in the message (see AgentSession.prompt → _expandSkillCommand /
// expandPromptTemplate, both guarded by text.startsWith("/")). Ryan routinely
// writes multi-step instructions where several steps are slash-commands sitting
// mid-sentence, e.g. "merge, monitor deploy, /browser-test". Those never fire.
//
// This module finds EVERY /command token wherever it appears and APPENDS the
// expanded skill/template content after the untouched user text, separated by
// INJECTED_COMMANDS_MARKER. The command stays in the message so the model (and
// replayed history) sees the invocation verbatim; only the expansion is
// injected. Callers must therefore also pass expandPromptTemplates: false to
// Pi, or Pi's own start-anchored expansion would re-expand the leading command.
// All behavior lives here in orchestrel; the only thing we borrow from Pi is
// the public resourceLoader lookup of what's installed.
//
// Argument syntax is explicit parens, always optional: `/pr(dev)` passes "dev",
// bare `/browser-test` passes no args. This makes each command's boundary
// unambiguous no matter where it sits in a sentence — a bare command never
// swallows the prose that follows it. Args are still substituted into prompt
// templates and appended after skill blocks; keeping the command means the
// args also remain visible in place (see expandInlineCommands).

// A /command is only recognized when preceded by start-of-string or whitespace,
// so paths (/tmp/x), URLs, and "and/or" never match. name = lowercase skill/
// prompt charset. Optional (...) args capture is non-greedy and single-line.
const COMMAND_RE = /(^|\s)\/([a-z0-9-]+)(?:\(([^)\n]*)\))?/g;

// Quote-aware arg splitter, copied from Pi's parseCommandArgs so orchestrel owns
// its behavior and never depends on Pi's internal module layout.
function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

// Placeholder substitution, copied from Pi's substituteArgs: $1.., $@/$ARGUMENTS,
// ${N:-default}, ${@:N}, ${@:N:L}. Same semantics so prompt templates authored
// for Pi behave identically when expanded here.
function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(' ');
  return content.replace(
    /\$\{(\d+):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_m, defaultNum, defaultValue, sliceStart, sliceLength, simple) => {
      if (defaultNum) {
        const value = args[parseInt(defaultNum, 10) - 1];
        return value ? value : defaultValue;
      }
      if (sliceStart) {
        let start = parseInt(sliceStart, 10) - 1;
        if (start < 0) start = 0;
        if (sliceLength) return args.slice(start, start + parseInt(sliceLength, 10)).join(' ');
        return args.slice(start).join(' ');
      }
      if (simple === 'ARGUMENTS' || simple === '@') return allArgs;
      return args[parseInt(simple, 10) - 1] ?? '';
    },
  );
}

// Inline a skill exactly like Pi's _expandSkillCommand: XML-wrapped body with a
// baseDir hint, args (if any) appended after the block.
function expandSkill(name: string, filePath: string, baseDir: string, argString: string): string {
  const body = stripFrontmatter(readFileSync(filePath, 'utf-8')).trim();
  const block = `<skill name="${name}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
  const args = argString.trim();
  return args ? `${block}\n\n${args}` : block;
}

// Expand every recognized /command in `text`. Unknown commands are left as plain
// literal text (never turned into dead markers), matching Pi's pass-through of
// unknown commands. Regions inside inline `code` spans and fenced ``` blocks are
// skipped so pasted code containing /foo is never clobbered.
//
// The returned text keeps `text` byte-for-byte and appends one expansion per
// recognized command after INJECTED_COMMANDS_MARKER. When there is nothing to
// inject the original string is returned unchanged.
export function expandInlineCommands(session: AgentSession, text: string): string {
  if (!text.includes('/')) return text;

  const skills = session.resourceLoader.getSkills().skills;
  const prompts = session.resourceLoader.getPrompts().prompts;
  const skillByName = new Map(skills.map((s) => [s.name, s]));
  const promptByName = new Map<string, PromptTemplate>(prompts.map((p) => [p.name, p]));

  const masked = maskCodeRegions(text);
  const injected: string[] = [];
  for (const m of masked.matchAll(COMMAND_RE)) {
    const name = m[2];
    const argString = m[3] ?? '';
    const skill = skillByName.get(name);
    const prompt = skill ? undefined : promptByName.get(name);
    if (!skill && !prompt) continue; // unknown → leave literal

    // Positions from the masked string are identical to the original because
    // masking only swaps characters, never changes length.
    if (skill) injected.push(expandSkill(skill.name, skill.filePath, skill.baseDir, argString));
    else if (prompt) injected.push(substituteArgs(prompt.content, parseCommandArgs(argString)));
  }
  if (injected.length === 0) return text;
  return `${text}${INJECTED_COMMANDS_MARKER}${injected.join('\n\n')}`;
}
