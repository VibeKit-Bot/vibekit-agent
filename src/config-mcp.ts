/**
 * Self-configuration MCP server.
 *
 * claude-cli spawns THIS process (stdio MCP transport) on every run, because
 * vibekit-agent always passes `--mcp-config` naming it. When the conversation
 * asks for a settings change ("use opus", "stop editing files", "switch to my
 * other repo"), claude calls `set_config` here; we forward it to the parent
 * vibekit-agent process over localhost HTTP (VK_CONFIG_PORT, set in the
 * mcp-config env), which is the only thing allowed to actually apply it.
 *
 * WHY A TOOL AND NOT JUST LETTING CLAUDE EDIT ~/.vibekit/config.json: it
 * already could — the default run passes --dangerously-skip-permissions. But
 * a tool is validated (no half-written JSON that bricks the next launch), it
 * survives a restrictive `allowedTools` (mcp__vkconfig__* is allowlisted
 * separately, so a user who locks Write down can still talk their way back
 * out), and it applies in-process instead of needing a reload from disk.
 *
 * Same hand-rolled JSON-RPC as approval-mcp.ts, for the same reason: the MCP
 * stdio transport is one JSON message per line and this needs four methods.
 *
 * Failure posture is REFUSE, not silently-succeed: if the parent is
 * unreachable or answers with garbage, the tool reports the failure so claude
 * tells the user their setting did not change. A config tool that pretends to
 * have worked is worse than one that errors.
 */
import * as http from 'http';
import * as readline from 'readline';

const PORT = Number(process.env.VK_CONFIG_PORT || 0);
// Set by the Codex engine; absent means Claude, which is every agent before Codex support.
const IS_CODEX = process.env.VK_ENGINE === 'codex';
const CODEX_MODELS = (process.env.VK_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);

const MODEL_DESCRIPTION = IS_CODEX
  ? `Model to run${CODEX_MODELS.length ? `, one of: ${CODEX_MODELS.join(', ')}` : ', e.g. gpt-5.6-sol'}. null clears the override.`
  : 'Model to run: "opus", "sonnet", "haiku", or a full claude model id. null clears the override.';

const TOOLS_DESCRIPTION = IS_CODEX
  ? 'Tool access. Codex honors two settings: an EMPTY array means full access (edits and commands '
    + 'allowed, a loosening change), and a read-only list such as ["Read","Grep"] means no edits and '
    + 'no commands. A list allowing edits but not commands (or the reverse) is refused.'
  : 'Tools the agent may use, e.g. ["Read","Grep"]. IMPORTANT: an EMPTY array means NO '
    + 'restrictions (every tool allowed), so emptying this list is a loosening change. To '
    + 'restrict the agent, pass the specific tools it should keep.';

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** Ask the parent agent process to read or apply settings. */
function askParent(action: 'get' | 'set', changes: unknown): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const fail = (text: string) => resolve({ ok: false, text });
    if (!PORT) return fail('Settings are unavailable (the agent did not pass a config port).');
    const body = JSON.stringify({ action, changes });
    const req = http.request(
      {
        host: '127.0.0.1', port: PORT, path: '/config', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        // A loosening change blocks on the phone's approval card, which the
        // parent caps at APPROVAL_TIMEOUT_MS. Sit slightly past that so this
        // never times out first and leaves claude with a false failure.
        timeout: 200_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (typeof parsed?.text === 'string') return resolve({ ok: !!parsed.ok, text: parsed.text });
          } catch { /* fall through */ }
          fail('The agent returned an unreadable response, so nothing changed.');
        });
      },
    );
    req.on('timeout', () => { req.destroy(); fail('The agent did not respond, so nothing changed.'); });
    req.on('error', () => fail('The agent is unreachable, so nothing changed.'));
    req.write(body);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'get_config',
    description:
      'Read this VibeKit agent\'s own settings: which model it runs, which tools it is allowed to '
      + 'use, its working directory, and whether supervised mode is on. Use this when the user asks '
      + 'what the agent is set to.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_config',
    description:
      'Change this VibeKit agent\'s own settings. Use this when the user asks the agent to change '
      + 'how it runs, e.g. "use opus", "stop editing files without asking me", "switch to my other '
      + 'repo", "turn on supervised mode". Settings take effect on the NEXT message, not the '
      + 'current one. Changes that REDUCE safety (turning supervised mode off, or widening the '
      + 'allowed-tools list) require the user to confirm on their phone and may be refused. This '
      + 'tool cannot change the pairing itself (auth token or server URL) by design.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: ['string', 'null'],
          description: MODEL_DESCRIPTION,
        },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: TOOLS_DESCRIPTION,
        },
        cwd: { type: 'string', description: 'Working directory to switch to. Must already exist.' },
        supervised: {
          type: 'boolean',
          description: 'When true, the agent asks the phone before each tool it would otherwise prompt for in a terminal.',
        },
      },
      required: [],
    },
  },
];

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg || {};

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vkconfig', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name: string = params?.name || '';
    const args = params?.arguments ?? {};
    if (name !== 'get_config' && name !== 'set_config') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true } });
      return;
    }
    void askParent(name === 'get_config' ? 'get' : 'set', args).then(({ ok, text }) => {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: !ok } });
    });
    return;
  }
  // Anything else: empty result for requests (never leave claude hanging),
  // silence for notifications.
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
});
