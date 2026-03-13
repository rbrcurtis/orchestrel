import { homedir } from 'os'
import { join } from 'path'

/** Encode a CWD path the same way the Claude SDK does for ~/.claude/projects/ */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

/** Get the full path to an SDK session JSONL file */
export function getSDKSessionPath(cwd: string, sessionId: string): string {
  return join(homedir(), '.claude', 'projects', encodeProjectDir(cwd), `${sessionId}.jsonl`)
}
