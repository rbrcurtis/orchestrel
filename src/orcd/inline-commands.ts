/* oxlint-disable orchestrel/log-before-early-return -- pure string-command expansion: early returns are no-op fast-paths and mapped string transforms without session context */
import { readFileSync } from 'fs';
import { stripFrontmatter } from '@earendil-works/pi-coding-agent';
import type { AgentSession, PromptTemplate } from '@earendil-works/pi-coding-agent';

// Orchestrel-only: Pi expands a skill/prompt slash-command ONLY when it is the
// first thing in the message (see AgentSession.prompt → _expandSkillCommand /
// expandPromptTemplate, both guarded by text.startsWith("/")). Ryan routinely
// writes multi-step instructions where several steps are slash-commands sitting
// mid-sentence, e.g. "merge, monitor deploy, /browser-test". Those never fire.
//
// This module expands EVERY /command token wherever it appears, before Pi sees
// the text — so Pi's own start-anchored expansion has nothing left to do (no
// double-expansion). All behavior lives here in orchestrel; the only thing we
// borrow from Pi is the public resourceLoader lookup of what's installed.
//
// Argument syntax is explicit parens, always optional: `/pr(dev)` passes "dev",
// bare `/browser-test` passes no args. This makes each command's boundary
// unambiguous no matter where it sits in a sentence — a bare command never
// swallows the prose that follows it.

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
export function expandInlineCommands(session: AgentSession, text: string): string {
  if (!text.includes('/')) return text;

  const skills = session.resourceLoader.getSkills().skills;
  const prompts = session.resourceLoader.getPrompts().prompts;
  const skillByName = new Map(skills.map((s) => [s.name, s]));
  const promptByName = new Map<string, PromptTemplate>(prompts.map((p) => [p.name, p]));

  const masked = maskCodeRegions(text);

  let out = '';
  let last = 0;
  for (const m of masked.matchAll(COMMAND_RE)) {
    const idx = m.index;
    // matchAll on the masked string; positions are identical to the original
    // because masking only swaps characters, never changes length.
    const lead = m[1];
    const name = m[2];
    const argString = m[3] ?? '';
    const skill = skillByName.get(name);
    const prompt = skill ? undefined : promptByName.get(name);
    if (!skill && !prompt) continue; // unknown → leave literal

    out += text.slice(last, idx) + lead;
    if (skill) out += expandSkill(skill.name, skill.filePath, skill.baseDir, argString);
    else if (prompt) out += substituteArgs(prompt.content, parseCommandArgs(argString));
    last = idx + m[0].length;
  }
  if (last === 0) return text; // nothing expanded
  return out + text.slice(last);
}

// Replace the contents of inline `code` spans and fenced ``` blocks with spaces
// of equal length. Same length in → same length out, so match indices from the
// masked string map 1:1 onto the original text.
function maskCodeRegions(text: string): string {
  const chars = text.split('');
  // Fenced blocks first (```...```), then inline spans (`...`).
  maskPattern(chars, /```[\s\S]*?```/g, text);
  maskPattern(chars, /`[^`\n]*`/g, chars.join(''));
  return chars.join('');
}

function maskPattern(chars: string[], re: RegExp, source: string): void {
  for (const m of source.matchAll(re)) {
    const start = m.index;
    for (let i = start; i < start + m[0].length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
}
