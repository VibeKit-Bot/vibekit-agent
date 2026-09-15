/**
 * Read-only filesystem tools for Codex Remote.
 *
 * Codex's native shell is disabled when the user selects a read-only tool
 * list. These MCP tools preserve useful code inspection without leaving a
 * command runner available to the model. Every path is confined to
 * VK_READ_ROOT, including through symlinks.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const ROOT = fs.realpathSync(process.env.VK_READ_ROOT || process.cwd());
const MAX_OUTPUT = 100_000;
const MAX_ENTRIES = 10_000;

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function insideRoot(candidate: string): string {
  const absolute = path.resolve(ROOT, candidate || '.');
  const real = fs.realpathSync(absolute);
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new Error('Path is outside the working directory');
  return real;
}

function cap(text: string): string {
  return text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n… output truncated`;
}

function globRegex(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') {
      out += '(?:.*/)?';
      i += 2;
    } else if (c === '*' && pattern[i + 1] === '*') { out += '.*'; i++; }
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += /[\\^$+?.()|{}\[\]]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(out + '$');
}

function walk(directory: string): string[] {
  const results: string[] = [];
  const pending = [directory];
  let scanned = 0;
  while (pending.length && scanned < MAX_ENTRIES) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++scanned > MAX_ENTRIES) break;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) results.push(relative);
    }
  }
  return results;
}

function runTool(name: string, input: any): string {
  if (name === 'Read') {
    const file = insideRoot(String(input?.file_path || input?.path || ''));
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const offset = Math.max(1, Number(input?.offset) || 1);
    const limit = Math.min(2_000, Math.max(1, Number(input?.limit) || 2_000));
    return cap(lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}\t${line}`).join('\n'));
  }
  if (name === 'LS') {
    const directory = insideRoot(String(input?.path || '.'));
    return cap(fs.readdirSync(directory, { withFileTypes: true })
      .slice(0, 2_000)
      .map((entry) => `${entry.isDirectory() ? 'd' : '-'} ${entry.name}${entry.isDirectory() ? '/' : ''}`)
      .join('\n'));
  }
  if (name === 'Glob') {
    const directory = insideRoot(String(input?.path || '.'));
    const matcher = globRegex(String(input?.pattern || '**/*'));
    return cap(walk(directory).filter((file) => matcher.test(file)).sort().join('\n'));
  }
  if (name === 'Grep') {
    const directory = insideRoot(String(input?.path || '.'));
    const matcher = input?.glob ? globRegex(String(input.glob)) : null;
    const expression = new RegExp(String(input?.pattern || ''), input?.case_insensitive ? 'i' : '');
    const matches: string[] = [];
    for (const relative of walk(directory)) {
      if (matcher && !matcher.test(relative)) continue;
      let contents: string;
      try {
        const stat = fs.statSync(path.join(directory, relative));
        if (stat.size > 2_000_000) continue;
        contents = fs.readFileSync(path.join(directory, relative), 'utf8');
      } catch { continue; }
      const lines = contents.split('\n');
      for (let i = 0; i < lines.length; i++) {
        expression.lastIndex = 0;
        if (expression.test(lines[i])) matches.push(`${relative}:${i + 1}:${lines[i]}`);
        if (matches.length >= 2_000) break;
      }
      if (matches.length >= 2_000) break;
    }
    return cap(matches.join('\n'));
  }
  throw new Error(`Unknown tool: ${name}`);
}

const TOOLS = [
  { name: 'Read', description: 'Read a text file inside the working directory.', inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] } },
  { name: 'Grep', description: 'Search file contents inside the working directory with a regular expression.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, case_insensitive: { type: 'boolean' } }, required: ['pattern'] } },
  { name: 'Glob', description: 'Find files inside the working directory by glob pattern.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'LS', description: 'List a directory inside the working directory.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: [] } },
];

readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  let message: any;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message || {};
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'vkread', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    try {
      const text = runTool(String(params?.name || ''), params?.arguments || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
    } catch (error: any) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(error?.message || error) }], isError: true } });
    }
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (id !== undefined && method !== 'notifications/initialized' && method !== 'initialized') {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
