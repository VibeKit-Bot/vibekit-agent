/**
 * Claude Code sessions saved on this computer for one folder, so the phone can
 * pick up a session started at the desk.
 *
 * Claude Code keeps every conversation as JSONL under
 * <config dir>/projects/<folder with each non-alphanumeric char as "-">/<uuid>.jsonl,
 * whether it ran in the terminal or headless (`claude -p`, which is how Remote
 * runs it). Resuming one is the same `--resume <id>` Remote already passes on
 * every message, so continuing a desk session is only choosing the id. It is a
 * handoff, not a shared screen: a terminal still open on that session will not
 * see the phone's turns until it is reopened with `claude --resume`.
 *
 * Read-only: nothing here writes to Claude's files.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ClaudeSessionSummary {
  id: string;
  /** The first thing the person typed, trimmed for a list row. */
  title: string;
  /** ISO time of the file's last write. */
  updatedAt: string;
}

export interface ClaudeTurn {
  role: 'user' | 'assistant';
  text: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 512 * 1024;
const TITLE_CHARS = 120;
const TURN_CHARS = 2000;

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/** The folder Claude Code files a working directory's sessions under. */
export function claudeProjectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(claudeProjectsDir(env), path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

export function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}

/** Text a person typed, or null for tool results, meta rows and injected blocks. */
function userText(row: any): string | null {
  if (row?.type !== 'user' || row.isMeta || row.isSidechain) return null;
  const content = row.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
      : '';
  const trimmed = text.trim();
  // Slash commands, caveats and reminders arrive as <tag>…</tag> blocks.
  if (!trimmed || trimmed.startsWith('<')) return null;
  return trimmed;
}

function assistantText(row: any): string | null {
  if (row?.type !== 'assistant' || row.isSidechain) return null;
  const content = row.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n').trim();
  return text || null;
}

function readSlice(file: string, from: 'head' | 'tail', bytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from === 'head' ? 0 : size - len);
    const text = buf.toString('utf8');
    // A slice can cut a line in half at its open end; drop that partial line.
    if (from === 'head') return len < size ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text: string): any[] {
  const rows: any[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn or foreign line */ }
  }
  return rows;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The folder's sessions, newest first. Sessions with nothing typed are skipped. */
export function listClaudeSessions(cwd: string, limit = 15, env: NodeJS.ProcessEnv = process.env): ClaudeSessionSummary[] {
  const dir = claudeProjectDir(cwd, env);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = names
    .filter((n) => n.endsWith('.jsonl') && isSessionId(n.slice(0, -6)))
    .map((n) => {
      const file = path.join(dir, n);
      try { return { id: n.slice(0, -6), file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter((f): f is { id: string; file: string; mtime: number } => !!f)
    .sort((a, b) => b.mtime - a.mtime);

  const out: ClaudeSessionSummary[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    let title: string | null = null;
    try {
      for (const row of parseLines(readSlice(f.file, 'head', HEAD_BYTES))) {
        title = userText(row);
        if (title) break;
      }
    } catch {
      continue;
    }
    if (!title) continue;
    out.push({ id: f.id, title: oneLine(title, TITLE_CHARS), updatedAt: new Date(f.mtime).toISOString() });
  }
  return out;
}

/** The session's file, only if it is one of this folder's sessions. */
export function claudeSessionFile(cwd: string, id: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isSessionId(id)) return null;
  const file = path.join(claudeProjectDir(cwd, env), `${id}.jsonl`);
  return fs.existsSync(file) ? file : null;
}

/** The last few things said in a session, oldest first, to show on the phone. */
export function recentClaudeTurns(file: string, max = 6): ClaudeTurn[] {
  const turns: ClaudeTurn[] = [];
  for (const row of parseLines(readSlice(file, 'tail', TAIL_BYTES))) {
    const user = userText(row);
    if (user) { turns.push({ role: 'user', text: user }); continue; }
    const said = assistantText(row);
    if (!said) continue;
    // One reply streams as several assistant rows; keep them as one turn.
    const last = turns[turns.length - 1];
    if (last?.role === 'assistant') last.text = `${last.text}\n\n${said}`;
    else turns.push({ role: 'assistant', text: said });
  }
  return turns.slice(-max).map((t) => ({
    role: t.role,
    text: t.text.length > TURN_CHARS ? `${t.text.slice(0, TURN_CHARS - 1)}…` : t.text,
  }));
}
