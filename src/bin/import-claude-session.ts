/**
 * CLI: import a Claude Code session transcript into Pi, preserving the session
 * id so an orchestrel card resumes the same conversation under the Pi harness.
 *
 *   tsx src/bin/import-claude-session.ts --session <claude-session-id> [--cwd <path>]
 *   tsx src/bin/import-claude-session.ts --file <path.jsonl> [--cwd <path>]
 *
 * --cwd overrides the working directory (defaults to the cwd recorded in the
 * transcript). --dry-run reports what would be written without writing.
 */
import arg from 'arg';
import { buildPiSession, findClaudeTranscript, importClaudeSession } from '../orcd/import-claude-session';

function main(): void {
  const args = arg({
    '--session': String,
    '--file': String,
    '--cwd': String,
    '--dry-run': Boolean,
    '-s': '--session',
    '-f': '--file',
  });

  const sessionId = args['--session'];
  const file = args['--file'];
  const cwd = args['--cwd'];

  if (!sessionId && !file) {
    console.error('error: pass --session <id> or --file <path.jsonl>');
    process.exit(1);
  }

  if (args['--dry-run']) {
    const jsonlPath = file ?? (sessionId ? findClaudeTranscript(sessionId) : undefined);
    if (!jsonlPath) {
      console.error(`error: Claude transcript not found (session ${sessionId ?? '?'})`);
      process.exit(1);
    }
    const built = buildPiSession(jsonlPath, sessionId, cwd);
    console.log(`[dry-run] source:   ${jsonlPath}`);
    console.log(`[dry-run] session:  ${built.sessionId}`);
    console.log(`[dry-run] cwd:      ${built.cwd}`);
    console.log(`[dry-run] messages: ${built.messages.length}`);
    return;
  }

  const result = importClaudeSession({ sessionId, file, cwd });
  console.log(`imported ${result.messageCount} messages`);
  console.log(`session:  ${result.sessionId}`);
  console.log(`cwd:      ${result.cwd}`);
  console.log(`written:  ${result.sessionFile}`);
}

main();
