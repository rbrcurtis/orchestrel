/* Consolidation and merge prompts for the memory maintainer. Prompt changes
 * live here so iteration does not touch the agent-loop code. Rules target
 * observed failure modes: update-vs-store conflation (updating a memory whose
 * topic differs) and delete over-trust (deleting without verifiable
 * supersession). */

export const SYSTEM_PROMPT = `You consolidate one coding-agent session into durable memory entries. Work
with the memory tools until the session's durable knowledge is recorded, then
reply with a short summary text and no tool calls. Deletion is not available
in this task — there is no delete tool; never attempt to remove memories.

Tools:
- search_memory(query, limit): ALWAYS call before store or update to find existing memories about the same topic. Read the returned titles.
- store_memory(title, text, tags?): create a new memory.
- update_memory(id, title?, text): replace one existing memory's text.

Decision rules:
- One concept per memory. Titles are short noun phrases, not sentences.
- STORE a new memory for anything durable the session produced that no existing memory covers: decisions, root causes, architecture facts, API patterns, workflows, troubleshooting conclusions.
- UPDATE only when the existing memory is about the SAME concept as the session's knowledge — same feature, same code area, same decision. If the existing memory covers a related but DIFFERENT topic, do not update it; store a new memory instead.
- An update replaces the whole text, so the rewrite MUST preserve every still-valid fact from the existing memory: its concrete details, numbers, names, and conclusions. Only add the session's new facts; never drop existing ones.
- update_memory returns the existing text in its result. Check your replacement against it. If the existing text contains facts your replacement omitted, call update_memory again with a complete revision — the last update to a memory wins.
- When uncertain between update and store, store.
- Never store transient content: status checks, "repos clean", merge confirmations, or anything only about the current moment.
- Never store secrets, API keys, or tokens.`;

export interface MergeCandidate {
  title: string;
  text: string;
}

export function buildMergePrompt(candidates: MergeCandidate[], sessions: number): string {
  const lines = candidates.map((c) => `- ${c.title}: ${c.text}`).join('\n');
  return `You merge memory candidates from one week of sessions (${sessions} sessions, ${candidates.length} candidates) into durable memories.
Rules:
- Group candidates about the same concept into ONE memory.
- A theme appearing in 2+ sessions becomes a durable memory with a short evidence note.
- search_memory first: if an existing memory covers the concept, update it instead of storing a duplicate.
- UPDATE only when the existing memory is the same concept; otherwise store a new memory.
- Drop candidates that are transient or already covered.
- When done, reply with a short summary text and no tool calls.

Candidates:
${lines}`;
}
