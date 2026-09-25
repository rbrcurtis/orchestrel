#!/usr/bin/env npx tsx
/**
 * Migrate OpenCode sessions to Claude Code SDK JSONL format.
 *
 * Usage:
 *   npx tsx scripts/migrate-oc-session.ts --session ses_xxx [--dry-run]
 *   npx tsx scripts/migrate-oc-session.ts --all [--dry-run]
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const all = argv.includes('--all');
const sidx = argv.indexOf('--session');
const singleSession = sidx !== -1 ? argv[sidx + 1] : undefined;

if (!all && !singleSession) {
  console.error('Usage: npx tsx scripts/migrate-oc-session.ts --session ses_xxx [--dry-run]');
  console.error('       npx tsx scripts/migrate-oc-session.ts --all [--dry-run]');
  process.exit(1);
}

// ── DB connections ───────────────────────────────────────────────────────────

const ocDb = new Database(join(homedir(), '.local/share/opencode/opencode.db'), { readonly: true });
const orchDb = new Database(join(process.cwd(), 'data/orchestrel.db'), { readonly: dryRun });

// ── Types ───────────────────────────────────────────────────────────────────

interface OcSession {
  id: string;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
}

interface OcMessage {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface OcPart {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
}

interface OrchCard {
  id: number;
  title: string;
  session_id: string;
  worktree_path: string | null;
  project_id: number | null;
}

interface OrchProject {
  id: number;
  path: string;
}

// ── Prepared statements ─────────────────────────────────────────────────────

const stmts = {
  ocSession: ocDb.prepare('SELECT * FROM session WHERE id = ?'),
  ocMessages: ocDb.prepare(
    'SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created',
  ),
  ocParts: ocDb.prepare(
    'SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY message_id, time_created',
  ),
  orchCard: orchDb.prepare('SELECT id, title, session_id, worktree_path, project_id FROM cards WHERE session_id = ?'),
  orchAllOcCards: orchDb.prepare(
    "SELECT id, title, session_id, worktree_path, project_id FROM cards WHERE session_id LIKE 'ses_%'",
  ),
  orchProject: orchDb.prepare('SELECT id, path FROM projects WHERE id = ?'),
  orchUpdate: dryRun ? null : orchDb.prepare('UPDATE cards SET session_id = ? WHERE id = ?'),
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Remove a directory we created, walking up to remove empty parents we also created. */
function rmdirRecursive(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ── Migration logic ─────────────────────────────────────────────────────────

function ts(epoch: number): string {
  return new Date(epoch).toISOString();
}

function migrateSession(ocSessionId: string, card: OrchCard): { ok: boolean; lines: number; error?: string } {
  const ocSession = stmts.ocSession.get(ocSessionId) as OcSession | undefined;
  if (!ocSession) return { ok: false, lines: 0, error: 'OC session not found in opencode.db' };

  // Determine cwd: card worktree_path → project path → OC session directory
  let cwd = card.worktree_path;
  if (!cwd && card.project_id) {
    const proj = stmts.orchProject.get(card.project_id) as OrchProject | undefined;
    if (proj) cwd = proj.path;
  }
  if (!cwd) cwd = ocSession.directory;
  if (!cwd) return { ok: false, lines: 0, error: 'No directory found' };

  // Create dir temporarily if it doesn't exist so realpathSync can resolve symlinks
  let createdDir = false;
  if (!existsSync(cwd)) {
    mkdirSync(cwd, { recursive: true });
    createdDir = true;
  }

  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = cwd;
  }

  // Clean up temp dir immediately — we only needed it for realpathSync
  if (createdDir) {
    try {
      rmdirRecursive(cwd);
    } catch {
      /* best effort */
    }
  }

  const messages = stmts.ocMessages.all(ocSessionId) as OcMessage[];
  const parts = stmts.ocParts.all(ocSessionId) as OcPart[];

  if (messages.length === 0) return { ok: false, lines: 0, error: 'No messages in OC session' };

  // Group parts by message_id
  const partsByMsg = new Map<string, OcPart[]>();
  for (const p of parts) {
    const arr = partsByMsg.get(p.message_id) ?? [];
    arr.push(p);
    partsByMsg.set(p.message_id, arr);
  }

  const newSessionId = randomUUID();
  const lines: string[] = [];

  // Header
  lines.push(
    JSON.stringify({
      type: 'permission-mode',
      permissionMode: 'bypassPermissions',
      sessionId: newSessionId,
    }),
  );

  let prevUuid: string | null = null;

  for (const msg of messages) {
    const msgData = JSON.parse(msg.data);
    const msgParts = partsByMsg.get(msg.id) ?? [];
    const role: string = msgData.role;

    if (role === 'user') {
      const textPart = msgParts.find((p) => {
        const d = JSON.parse(p.data);
        return d.type === 'text';
      });
      if (!textPart) continue;

      const textData = JSON.parse(textPart.data);
      const uuid = randomUUID();

      lines.push(
        JSON.stringify({
          parentUuid: prevUuid,
          isSidechain: false,
          type: 'user',
          message: { role: 'user', content: textData.text },
          uuid,
          timestamp: ts(msg.time_created),
          userType: 'external',
          cwd,
          sessionId: newSessionId,
          version: '0.0.0-migrated',
        }),
      );

      prevUuid = uuid;
    } else if (role === 'assistant') {
      // Group parts into steps (between step-start and step-finish)
      const steps: OcPart[][] = [];
      let cur: OcPart[] = [];

      for (const p of msgParts) {
        const d = JSON.parse(p.data);
        if (d.type === 'step-start') {
          cur = [];
        } else if (d.type === 'step-finish') {
          steps.push(cur);
          cur = [];
        } else {
          cur.push(p);
        }
      }
      if (cur.length > 0) steps.push(cur);

      for (const step of steps) {
        const contentBlocks: unknown[] = [];
        const toolCalls: Array<{ callID: string; tool: string; input: unknown; output: unknown }> = [];

        for (const p of step) {
          const d = JSON.parse(p.data);

          switch (d.type) {
            case 'reasoning':
              contentBlocks.push({ type: 'thinking', thinking: d.text });
              break;
            case 'text':
              if (d.text) contentBlocks.push({ type: 'text', text: d.text });
              break;
            case 'tool': {
              const callID = d.callID ?? randomUUID();
              contentBlocks.push({
                type: 'tool_use',
                id: callID,
                name: d.tool,
                input: d.state?.input ?? {},
              });
              toolCalls.push({
                callID,
                tool: d.tool,
                input: d.state?.input ?? {},
                output: d.state?.output ?? '',
              });
              break;
            }
          }
        }

        if (contentBlocks.length === 0) continue;

        const aUuid = randomUUID();
        const model = msgData.modelID ?? 'claude-sonnet-4-6';

        lines.push(
          JSON.stringify({
            parentUuid: prevUuid,
            isSidechain: false,
            type: 'assistant',
            message: {
              model,
              id: `msg_migrated_${aUuid.slice(0, 12)}`,
              type: 'message',
              role: 'assistant',
              content: contentBlocks,
              stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
            uuid: aUuid,
            timestamp: ts(msg.time_created),
            userType: 'external',
            cwd,
            sessionId: newSessionId,
            version: '0.0.0-migrated',
          }),
        );

        prevUuid = aUuid;

        if (toolCalls.length > 0) {
          const trUuid = randomUUID();
          const toolResults = toolCalls.map((tc) => ({
            type: 'tool_result',
            tool_use_id: tc.callID,
            content:
              typeof tc.output === 'string'
                ? [{ type: 'text', text: tc.output }]
                : [{ type: 'text', text: JSON.stringify(tc.output) }],
          }));

          lines.push(
            JSON.stringify({
              parentUuid: prevUuid,
              isSidechain: false,
              type: 'user',
              message: { role: 'user', content: toolResults },
              uuid: trUuid,
              timestamp: ts(msg.time_created),
              toolUseResult: {},
              sourceToolAssistantUUID: prevUuid,
              userType: 'external',
              cwd,
              sessionId: newSessionId,
              version: '0.0.0-migrated',
            }),
          );

          prevUuid = trUuid;
        }
      }
    }
  }

  // Write output
  const slug = realCwd.replace(/\//g, '-');
  const projDir = join(homedir(), '.claude/projects', slug);
  const jsonlPath = join(projDir, `${newSessionId}.jsonl`);

  if (!dryRun) {
    mkdirSync(projDir, { recursive: true });
    writeFileSync(jsonlPath, lines.map((l) => l + '\n').join(''));
    stmts.orchUpdate!.run(newSessionId, card.id);
  }

  return { ok: true, lines: lines.length };
}

// ── Main ────────────────────────────────────────────────────────────────────

if (singleSession) {
  const card = stmts.orchCard.get(singleSession) as OrchCard | undefined;
  if (!card) {
    console.error(`No orchestrel card found with session_id = ${singleSession}`);
    process.exit(1);
  }

  console.log(`Card #${card.id}: ${card.title}`);
  const result = migrateSession(singleSession, card);
  if (result.ok) {
    console.log(`${dryRun ? '[DRY RUN] ' : ''}Migrated: ${result.lines} JSONL lines`);
  } else {
    console.error(`Failed: ${result.error}`);
    process.exit(1);
  }
} else {
  // --all mode
  const cards = stmts.orchAllOcCards.all() as OrchCard[];
  console.log(`Migrating ${cards.length} cards with OC sessions...${dryRun ? ' [DRY RUN]' : ''}\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const card of cards) {
    const result = migrateSession(card.session_id, card);
    if (result.ok) {
      ok++;
      process.stdout.write('.');
    } else {
      failed++;
      process.stdout.write('x');
      console.error(`\n  Card #${card.id} (${card.title}): ${result.error}`);
    }

    // Print progress every 50
    if ((ok + skipped + failed) % 50 === 0) {
      process.stdout.write(` ${ok + skipped + failed}/${cards.length}\n`);
    }
  }

  console.log(`\n\nDone. ${ok} migrated, ${failed} failed, ${skipped} skipped.`);
}

ocDb.close();
orchDb.close();
