/**
 * Permission-prompt MCP server for supervised mode.
 *
 * claude-cli spawns THIS process (stdio MCP transport) when vibekit-agent
 * passes `--permission-prompt-tool mcp__vkapprove__approve`. Every time
 * claude wants to use a tool that would normally show a terminal prompt, it
 * calls our `approve` tool instead; we forward the question to the parent
 * vibekit-agent process over localhost HTTP (VK_APPROVAL_PORT, set in the
 * mcp-config env), the parent relays it to the phone over its WebSocket,
 * and the eventual allow/deny comes back as this tool's result.
 *
 * Hand-rolled JSON-RPC on purpose: the MCP stdio transport is one JSON
 * message per line, and this needs exactly four methods — pulling in the
 * SDK would double the package's install size for ~80 lines of protocol.
 *
 * Failure posture is DENY: if the parent is unreachable, times out, or
 * returns garbage, the tool is refused with a reason claude can read out
 * loud. Supervised mode must never fail open into "allowed".
 */
import * as http from 'http';
import * as readline from 'readline';

const PORT = Number(process.env.VK_APPROVAL_PORT || 0);

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** Ask the parent agent process to get a decision from the phone. */
function askParent(toolName: string, input: unknown): Promise<{ behavior: string; message?: string; updatedInput?: unknown }> {
  return new Promise((resolve) => {
    const deny = (message: string) => resolve({ behavior: 'deny', message });
    if (!PORT) return deny('Supervised mode misconfigured (no approval port).');
    const body = JSON.stringify({ toolName, input });
    const req = http.request(
      {
        host: '127.0.0.1', port: PORT, path: '/approve', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        // The parent enforces the real deadline (and answers with a deny at
        // it) — this is a backstop slightly past that so we never hang claude.
        timeout: 200_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed?.behavior === 'allow' || parsed?.behavior === 'deny') return resolve(parsed);
          } catch { /* fall through to deny */ }
          deny('Approval service returned an invalid response.');
        });
      },
    );
    req.on('timeout', () => { req.destroy(); deny('No approval decision arrived in time.'); });
    req.on('error', () => deny('Approval service unreachable.'));
    req.write(body);
    req.end();
  });
}

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
        serverInfo: { name: 'vkapprove', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0', id,
      result: {
        tools: [{
          name: 'approve',
          description: 'Forwards a tool-permission prompt to the VibeKit phone app and returns the allow/deny decision.',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string' },
              input: { type: 'object' },
              tool_use_id: { type: 'string' },
            },
            required: ['tool_name', 'input'],
          },
        }],
      },
    });
    return;
  }
  if (method === 'tools/call') {
    const toolName: string = params?.arguments?.tool_name || 'unknown tool';
    const input = params?.arguments?.input ?? {};
    void askParent(toolName, input).then((decision) => {
      // The permission-prompt contract: the tool RESULT's text content is a
      // JSON-stringified {behavior:'allow', updatedInput} | {behavior:'deny',
      // message}. `updatedInput` is required on allow — we pass the original.
      const payload = decision.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
        : { behavior: 'deny', message: decision.message || 'Denied from the VibeKit app.' };
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      });
    });
    return;
  }
  // Anything else: empty result for requests (never leave claude hanging),
  // silence for notifications.
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
});
