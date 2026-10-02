import WebSocket from 'ws';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { spawn, ChildProcess, execSync, execFile } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dns from 'dns';
import {
  Config, ConfigChange, describeLoosenings, isValidModel, CONFIG_CHANGE_KEYS,
  Engine, CodexAccess, codexAccessFor, codexToolListProblem, codexReportedTools,
} from './config';
import { CodexEngine, CODEX_TESTED_VERSION, McpServerSpec, VKCONFIG_SERVER, codexLoggedIn, findCodexBinary, isOlderVersion } from './codex-engine';
import { CODEX_NOT_INSTALLED, CodexTurnEnd, codexErrorReply } from './codex-translate';
import { localImageRefs, readImageForPhone } from './local-images';
import { listClaudeSessions, claudeSessionFile, recentClaudeTurns } from './claude-sessions';

/** The phone's answer to anything we blocked on: a tool permission prompt, or
 *  a config change that would reduce safety. */
interface PhoneDecision {
  behavior: 'allow' | 'deny';
  message?: string;
}

/**
 * The self-config tools, by the names claude allowlists them under.
 *
 * These are appended to EVERY `--allowedTools` list we build. That is the
 * anti-lockout property: a user who says "only let yourself read files" would
 * otherwise also revoke the single mechanism for undoing it from their phone,
 * and would be stranded until they walked back to the machine. MCP tools are
 * allowlisted by their own names, so restricting Write or Bash never touches
 * these two.
 */
const CONFIG_TOOL_NAMES = ['mcp__vkconfig__get_config', 'mcp__vkconfig__set_config'];

/** Shape of GET /api/agent/claude-credentials — the user's own Claude creds. */
interface ServerClaudeCreds {
  hasCredentials: boolean;
  expired?: boolean;
  type?: 'oauth' | 'api_key';
  oauthToken?: string;
  apiKey?: string;
  subscriptionType?: string;
}

/**
 * Read the package version from package.json dynamically. Until 1.1.0 this
 * was hardcoded to a string literal in the auth handshake, which meant
 * every published bump (1.0.28 → 1.0.29 → 1.0.30 → 1.0.31 → 1.1.0) shipped
 * with the wrong number until someone remembered to update both. Reading
 * the JSON keeps the value in lockstep with whatever npm just published.
 */
const AGENT_VERSION: string = (() => {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || 'unknown';
  } catch { return 'unknown'; }
})();

/**
 * Find the claude binary by checking common installation locations
 */
function findClaudeBinary(): string | null {
  // Check for CLAUDE_PATH environment variable first (allows user override)
  if (process.env.CLAUDE_PATH && fs.existsSync(process.env.CLAUDE_PATH)) {
    return process.env.CLAUDE_PATH;
  }

  const homedir = os.homedir();

  // Build list of possible paths
  const possiblePaths: string[] = [
    // Anthropic's native installer (`claude install`) — lands here by default
    // and is the current recommended install path as of Claude Code 2.1.x.
    path.join(homedir, '.local', 'bin', 'claude'),
    // Homebrew on macOS (Apple Silicon and Intel)
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    // npm global installs with common prefixes
    path.join(homedir, '.npm-global', 'bin', 'claude'),
    '/usr/local/lib/node_modules/.bin/claude',
    // Claude desktop app location on macOS
    '/Applications/Claude.app/Contents/Resources/claude',
  ];

  // Try to get npm global bin directory dynamically
  try {
    const npmBin = execSync('npm bin -g 2>/dev/null', {
      encoding: 'utf-8',
      env: { ...process.env, PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:' + (process.env.PATH || '') }
    }).trim();
    if (npmBin) {
      possiblePaths.unshift(path.join(npmBin, 'claude'));
    }
  } catch {
    // Ignore
  }

  // Check nvm paths
  const nvmDir = process.env.NVM_DIR || path.join(homedir, '.nvm');
  if (fs.existsSync(nvmDir)) {
    // Check common node versions
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    if (fs.existsSync(versionsDir)) {
      try {
        const versions = fs.readdirSync(versionsDir);
        for (const v of versions) {
          possiblePaths.push(path.join(versionsDir, v, 'bin', 'claude'));
        }
      } catch {
        // Ignore
      }
    }
  }

  // Also check fnm (Fast Node Manager) paths
  const fnmDir = process.env.FNM_MULTISHELL_PATH || path.join(homedir, '.fnm');
  if (fs.existsSync(fnmDir)) {
    possiblePaths.push(path.join(fnmDir, 'bin', 'claude'));
  }

  // Check each path
  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        // Verify it's executable
        fs.accessSync(p, fs.constants.X_OK);
        console.log(`Found claude at: ${p}`);
        return p;
      }
    } catch {
      // Not accessible, continue
    }
  }

  // Last resort: try which command with enhanced PATH
  try {
    const enhancedPath = [
      path.join(homedir, '.local', 'bin'),  // native installer default
      '/opt/homebrew/bin',
      '/usr/local/bin',
      path.join(homedir, '.npm-global', 'bin'),
      process.env.PATH || ''
    ].join(':');

    const result = execSync('which claude', {
      encoding: 'utf-8',
      env: { ...process.env, PATH: enhancedPath }
    }).trim();

    if (result && fs.existsSync(result)) {
      console.log(`Found claude via which: ${result}`);
      return result;
    }
  } catch {
    // Not found
  }

  return null;
}

// Strip ANSI escape codes
interface WSMessage {
  type: string;
  payload?: unknown;
  timestamp: number;
  messageId: string;
}

interface MessageAttachment {
  type: 'voice' | 'image' | 'document';
  data: string;           // Base64 encoded file data
  mimeType: string;       // e.g., 'audio/ogg', 'image/jpeg'
  filename: string;       // Original or generated filename
  duration?: number;      // Duration in seconds (for voice)
  width?: number;         // Image width
  height?: number;        // Image height
}

/**
 * The one run in flight, whichever engine runs it. Busy state, Stop,
 * supersede, the run timeout, the self-update idle check and shutdown all go
 * through this, so they behave the same for Claude and Codex.
 */
interface ActiveRun {
  engine: 'claude' | 'codex';
  /** End the run now. `force` is the run timeout: stop without waiting. */
  stop(force?: boolean): void;
}

interface UserMessage {
  type: 'message';
  payload: {
    telegramId: number;
    chatId: number;
    text: string;
    messageId: number;
    attachments?: MessageAttachment[];
    // Supervised mode: run claude WITHOUT --dangerously-skip-permissions and
    // forward each permission prompt to the phone. Absent = off.
    supervised?: boolean;
  };
}

export class AgentClient {
  private config: Config;
  private ws: WebSocket | null = null;
  private activeRun: ActiveRun | null = null;
  /** Which coding agent this machine runs. Decided at `link`; see start(). */
  private engine: Engine = 'claude';
  /** The Codex app-server driver, created on the first Codex message and kept for the process. */
  private codex: CodexEngine | null = null;
  /** The Codex CLI that runs here; looked up again on each message while missing. */
  private codexBinary: { path: string; version: string } | null = null;
  private caffeinateProcess: ChildProcess | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private isConnected = false;
  private currentChatId: number | null = null;
  private currentTelegramId: number | null = null;
  private currentReplyToMessageId: number | null = null;
  // True in ephemeral Docker/auto-mode containers — auto-update is skipped
  // there (each container gets a fresh install, and a mid-build restart would
  // kill the running task).
  private autoMode = false;

  // ── Supervised mode (phone approvals) ──
  // Whether the CURRENT message asked for supervision (rides on each
  // UserMessage; the toggle lives server-side on the remote_agents row).
  private currentSupervised = false;
  // Localhost HTTP server our MCP children call back into: /approve for
  // supervised-mode permission prompts, /config for self-configuration.
  // Started lazily on the first run that attaches an MCP server, kept for
  // the process lifetime.
  private controlServer: http.Server | null = null;
  private controlPort = 0;
  // requestId -> the waiting caller's resolver + its deadline timer. Shared
  // by both callers of askPhone (a tool permission prompt, and a config
  // change that would reduce safety).
  private pendingApprovals: Map<string, { resolve: (d: PhoneDecision) => void; timer: NodeJS.Timeout }> = new Map();
  // mcp-config written next to the OS tmpdir once per process.
  private mcpConfigPath: string | null = null;
  /** How long the phone gets before the agent denies locally. Well inside
   *  the server's 5-minute per-run SSE ceiling, so a silent phone degrades
   *  into a readable deny instead of a dead turn. */
  private static readonly APPROVAL_TIMEOUT_MS = 180_000;
  // Set once we've kicked off an auto-update this process, so a flurry of
  // reconnects (each delivering auth_success) can't launch npm repeatedly.
  private updateAttempted = false;
  private streamingInterval: NodeJS.Timeout | null = null;
  private currentMessageId: number | null = null;
  private workingDirectory: string = process.cwd();

  // stream-json parsing state
  private streamJsonResult: string = '';
  // Claude sometimes returns an ERROR string as its `result` (is_error:true) —
  // notably auth failures, which come back as subtype:"success" + is_error:true
  // + result:"Invalid API key · Please run /login". That text must NOT be
  // forwarded to the app as a real reply (an in-app user can't run /login); we
  // stash it here so the run-end handler can classify + translate it.
  private lastRunResultError: string = '';
  // Tracks whether we've received any partial-message deltas for the
  // current run. When true, the final `assistant` event's text content is
  // already in streamJsonResult — re-concatenating it would duplicate the
  // response. Cleared at run start.
  private receivedPartialDeltas: boolean = false;
  // Heartbeat status timers — fire if Claude doesn't emit a tool call or
  // any text within 1.5s / 8s of spawn. Without these, conversational
  // questions that just generate text (no tools) feel like nothing's
  // happening on the iOS side until the first delta lands. Real activity
  // (tool use or text delta) cancels remaining heartbeats.
  private heartbeatTimers: NodeJS.Timeout[] = [];
  private streamJsonLineBuffer: string = '';

  // Tail of the current claude run's stderr, used to classify auth failures
  // into an actionable message instead of a generic "exited" fallback.
  private lastRunStderr: string = '';

  // Coalesce live-streaming WS sends so a burst of small Claude deltas
  // doesn't fan out into dozens of WS frames per second. scheduleStreamingFlush
  // sets this and clears it after one drain; the worst-case latency added is
  // roughly STREAM_FLUSH_DEBOUNCE_MS, which is unnoticeable to the user.
  private streamingFlushTimer: NodeJS.Timeout | null = null;
  private static readonly STREAM_FLUSH_DEBOUNCE_MS = 80;
  private lastStreamedLength = 0;

  // Track in-flight tool_use calls so we can correlate their tool_result output
  private activeToolCalls: Map<string, { name: string; input: Record<string, any> }> = new Map();

  // Count of tool_use events seen this run — used for the "ended without text"
  // fallback message so we don't silently claim success.
  private toolUseCountThisRun = 0;

  // Cap captured tool output payloads to stay WS-friendly
  private static readonly TOOL_OUTPUT_MAX_BYTES = 8 * 1024;

  // Heartbeat watchdog: detect dead WS connections without waiting for the
  // server's 240s ceiling. Server pings every 5s — if we haven't heard one
  // in 60s the TCP is almost certainly wedged (sleep, Wifi flap, etc.) even
  // though ws.readyState still says OPEN. Terminate + reconnect eagerly.
  private lastServerPingAt: number = 0;
  private heartbeatWatchdog: NodeJS.Timeout | null = null;
  private static readonly SERVER_SILENCE_TIMEOUT_MS = 60_000;
  private static readonly WATCHDOG_INTERVAL_MS = 10_000;

  // Wake watchdog: setInterval pauses while the host is asleep, so the
  // heartbeat check above only fires *after* wake (and reports a misleading
  // multi-minute silence). A fast 1s ticker that compares wall-clock deltas
  // catches the wake instantly — if a tick fires after >5s of real time, we
  // know the OS slept (or the Node process was paused for some other reason)
  // and the WS is almost certainly stale. Force-reconnect immediately
  // instead of waiting for the heartbeat watchdog to notice.
  private lastWakeTickAt: number = 0;
  private wakeWatchdog: NodeJS.Timeout | null = null;
  private static readonly WAKE_TICK_INTERVAL_MS = 1_000;
  private static readonly WAKE_GAP_THRESHOLD_MS = 5_000;

  // Conversation memory: track if we should continue the previous conversation
  private hasActiveConversation = false;

  // Captured from the `system/init` event of each Claude run. When set,
  // subsequent runs use `--resume <id>` instead of `--continue` so we
  // deterministically resume THIS conversation — not whatever happens to be
  // the most-recent claude session in the cwd. Critical when the user runs
  // their own `claude` process in the same directory between our turns: with
  // `--continue` we'd silently hijack their session; with `--resume <id>` we
  // stay pinned to ours.
  private currentSessionId: string | null = null;

  // Outgoing WS message queue used while this.ws is not OPEN. Bounded to keep
  // a flaky network from blowing memory; old messages are dropped first. Flushed
  // on ws.on('open'). Without this, response/streaming/status frames sent during
  // a brief disconnect (Mac wake from sleep, WiFi flap) were silently lost.
  private outboundQueue: WSMessage[] = [];
  private static readonly MAX_OUTBOUND_QUEUE = 200;

  // Set true at spawn-time iff this run was started with --resume <id>.
  // Used in the close handler to clear a stale currentSessionId if the
  // resume failed, instead of looping forever on the same dead id.
  private resumedSessionThisRun = false;

  // Hard kill timer for a wedged run. Mirrors the server's 5-min SSE
  // ceiling at src/routes/remote-app.ts so client + server agree on "this
  // run is dead". Without this the active run can sit forever on
  // an infinite bash loop / stuck API call, blocking every subsequent
  // message and leaving the user staring at a spinner.
  private runTimeout: NodeJS.Timeout | null = null;
  private static readonly RUN_TIMEOUT_MS = 5 * 60_000;

  // Set when handleUserMessage acknowledged the cancellation of a previous
  // in-flight run before overwriting currentChatId. Stops the killed run's
  // 'close' handler from sending a "no response" fallback to the NEW chatId
  // (currentChatId has already moved on to the new message). Without this
  // flag, the new message's chat would receive a confusing "Agent exited
  // without a response (code -15)" before its real reply.
  /// Runs stopped on purpose (supersede / Stop / run-timeout). Keyed by
  /// the run itself so a slow-dying old run can never consume a flag
  /// meant for the new one — the old shared boolean did exactly that.
  private canceledRuns = new WeakSet<ActiveRun>();

  // After a network change (Wi-Fi flap, sleep/wake), macOS's DNS resolver can
  // take 60-90s to come back. Without this flag we burn 1+2+4+8+16=31s on
  // attempts that are guaranteed to fail with ENOTFOUND. Set by the 'error'
  // handler when it sees a DNS error; consumed by scheduleReconnect to floor
  // the next delay to 10s.
  private lastErrorWasDns = false;
  private static readonly DNS_FAILURE_MIN_DELAY_MS = 10_000;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Link this computer to an iOS or Telegram account
   */
  async link(requestedEngine?: Engine): Promise<void> {
    let startNow = false;
    console.log('Connecting to VibeKit...\n');

    // Request a link from the server
    const serverUrl = process.env.VIBEKIT_SERVER || 'https://vibekit.bot';

    try {
      const result = await this.pairThisComputer(serverUrl, requestedEngine);

      const wasLinked = this.config.hasToken();
      this.config.setCredentials(result.token, result.wsUrl);

      // The engine is decided HERE, not at `start`. By the time `start` runs
      // every machine has a token, so it cannot tell a new link from a machine
      // linked before Codex support, which must stay on Claude (start() pins
      // those). A re-link keeps whatever engine was already chosen, and a
      // re-link of a machine linked before Codex support stays on Claude.
      // `link codex` / `link claude` (the command the app shows) wins over both.
      const engine: Engine = requestedEngine
        ?? this.config.getEngine()
        ?? (wasLinked ? 'claude' : findClaudeBinary() ? 'claude' : findCodexBinary(() => {}) ? 'codex' : 'claude');
      const clearedModel = this.config.setEngine(engine);

      console.log('\nLinked successfully!');
      console.log('');
      if (engine === 'codex') {
        console.log(requestedEngine ? 'This computer will run Codex.' : 'This computer will run Codex (Claude Code was not found here).');
        console.log('Make sure Codex is logged in on this computer: codex login');
      } else {
        console.log('Tip: connect Claude in the VibeKit app (Profile → Connect Claude)');
        console.log('and the agent signs Claude in automatically — no setup-token needed.');
      }
      if (clearedModel) console.log(`Cleared the model setting "${clearedModel}": it was for the other coding agent.`);
      console.log('');

      // One command instead of two. Pairing and then separately starting is
      // where most people who generated a code never connected a computer
      // (51 codes, 4 linked, 2026-08-01). Asked only at a terminal; Enter
      // alone means yes, and "n" leaves the old two-step path intact.
      if (process.stdin.isTTY && await this.askYesNo(`Start the agent now in ${process.cwd()}? (Y/n) `)) {
        startNow = true;
      } else {
        console.log('Start the agent with:');
        console.log('  npx vibekit-agent start');
        console.log('To switch coding agents later: npx vibekit-agent start codex (or start claude)');
        console.log('');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Link failed:', message);
      process.exit(1);
    }
    // Outside the try: a start failure is not a link failure, and start()
    // never returns while the agent runs.
    if (startNow) {
      console.log('');
      await this.start(process.cwd());
    }
  }

  /** One yes/no question at the terminal. Enter alone means yes. */
  private async askYesNo(question: string): Promise<boolean> {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    rl.close();
    return !/^n/i.test(answer.trim());
  }

  /**
   * Pair by QR (current app) or by a typed code (older apps), whichever lands
   * first. The server opens a pairing session this terminal prints as a QR
   * plus a short code, and the terminal polls for the phone's approval. At a
   * terminal the old prompt stays open beside it, so someone on an app build
   * that cannot scan still pairs the way they always did. If the server cannot
   * open a session (older or self-hosted server, network trouble), only the
   * typed code is offered, exactly as before 1.7.0.
   */
  private async pairThisComputer(serverUrl: string, requestedEngine?: Engine): Promise<{ token: string; wsUrl: string }> {
    const interactive = !!process.stdin.isTTY;
    let session = await this.startPairSession(serverUrl, requestedEngine);
    if (session) {
      this.printPairSession(session);
    } else {
      // Same words as the app's buttons (check:pairsessions pins them). While
      // the server's QR is off, the app's second step is this code.
      console.log('To link this computer, open the VibeKit app and go to Remote.');
      console.log('Tap "Connect a computer", then Next, and type the code it shows here.');
      console.log('Older app? Tap "Pair an agent" instead.');
      console.log('');
      if (!interactive) throw new Error('Could not start a pairing session, and there is no terminal to type a code into.');
    }
    const prompt = session ? 'Older VibeKit app? Type the code it shows here: ' : 'Enter the code from the VibeKit app: ';

    const readline = await import('readline');
    type Outcome = { token: string; wsUrl: string; account?: string | null; session?: { id: string; secret: string } };
    const outcome = await new Promise<Outcome>((resolve, reject) => {
      let done = false;
      let timer: NodeJS.Timeout | null = null;
      let rl: import('readline').Interface | null = null;
      const settle = () => {
        done = true;
        if (timer) clearTimeout(timer);
        rl?.close();
      };
      const finish = (result: Outcome) => { if (!done) { settle(); resolve(result); } };
      const fail = (err: Error) => { if (!done) { settle(); reject(err); } };

      if (interactive) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        // readline swallows Ctrl+C. Without this the prompt closed but the poll
        // below kept the process alive, and a late approval still linked the
        // computer the person had just cancelled.
        rl.on('SIGINT', () => {
          settle();
          console.log('\nCancelled. This computer was not linked.');
          process.exit(130);
        });
        const ask = () => {
          if (done || !rl) return;
          rl.question(prompt, async (answer) => {
            if (done) return;
            const code = answer.trim().toUpperCase();
            // Enter alone just keeps waiting for the phone.
            if (!code) { ask(); return; }
            if (code.length !== 6) {
              console.log(`Code is 6 characters (got ${code.length}). Try again or press Ctrl+C to cancel.`);
              ask();
              return;
            }
            console.log('\nValidating code...');
            let response: Response;
            try {
              response = await this.fetchWithTimeout(`${serverUrl}/api/agent/link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
              });
            } catch (e: any) {
              console.log(`Network error: ${e?.message || e}. Try again or press Ctrl+C to cancel.\n`);
              ask();
              return;
            }
            if (!response.ok) {
              const errorData = (await response.json().catch(() => ({ error: 'Unknown error' }))) as { error?: string };
              console.log(`${errorData.error || 'Invalid or expired code'}. Get a fresh code in the VibeKit app and try again, or press Ctrl+C to cancel.\n`);
              ask();
              return;
            }
            finish((await response.json()) as { token: string; wsUrl: string });
          });
        };
        ask();
      }

      const poll = async () => {
        if (done || !session) return;
        const current = session;
        let next = 2000;
        try {
          const r = await this.claimPairSession(serverUrl, current);
          if (done) return;
          if (r.kind === 'paired') {
            finish({ token: r.token, wsUrl: r.wsUrl, account: r.account, session: { id: current.id, secret: current.secret } });
            return;
          }
          if (r.kind === 'stop') {
            console.log(`\n${r.message}`);
            if (!interactive) fail(new Error(r.message));
            else process.stdout.write(prompt);
            return;
          }
          if (r.kind === 'renew') {
            const fresh = await this.startPairSession(serverUrl, requestedEngine);
            if (done) return;
            if (fresh) {
              console.log(`\n${r.message}`);
              session = fresh;
              this.printPairSession(fresh);
              if (interactive) process.stdout.write(prompt);
            } else {
              next = 10_000;
            }
          }
        } catch {
          next = 5000; // network trouble or a rate limit: keep waiting
        }
        if (!done) timer = setTimeout(poll, next);
      };
      if (session) timer = setTimeout(poll, 2000);
    });

    // Anyone who can see a QR (a screen share, a shoulder) can approve it, and
    // approving binds this computer to THEIR account. So name the account that
    // approved and, at a terminal, let the person here refuse before anything
    // is saved; a refusal deletes the agent the claim created.
    if (outcome.session) {
      const who = outcome.account || 'a VibeKit account';
      console.log(`\nApproved on a phone signed in to ${who}.`);
      if (interactive && !(await this.askYesNo(`Link this computer to ${who}? (Y/n) `))) {
        await this.rejectPairSession(serverUrl, outcome.session).catch(() => {});
        throw new Error('Not linked. Run the command again and approve it from your own phone.');
      }
    }
    return { token: outcome.token, wsUrl: outcome.wsUrl };
  }

  private async rejectPairSession(serverUrl: string, session: { id: string; secret: string }): Promise<void> {
    await this.fetchWithTimeout(`${serverUrl}/api/agent/pair-sessions/${encodeURIComponent(session.id)}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: session.secret }),
    });
  }

  private async startPairSession(serverUrl: string, requestedEngine?: Engine): Promise<{ id: string; secret: string; code: string; pairUrl: string } | null> {
    try {
      const res = await this.fetchWithTimeout(`${serverUrl}/api/agent/pair-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: requestedEngine ?? this.config.getEngine() ?? null,
          hostname: os.hostname(),
          platform: os.platform(),
          agentVersion: AGENT_VERSION,
        }),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as any;
      if (typeof j?.sessionId !== 'string' || typeof j?.secret !== 'string' || typeof j?.pairUrl !== 'string') return null;
      return { id: j.sessionId, secret: j.secret, code: String(j.code || ''), pairUrl: j.pairUrl };
    } catch {
      return null;
    }
  }

  private async claimPairSession(
    serverUrl: string,
    session: { id: string; secret: string },
  ): Promise<{ kind: 'paired'; token: string; wsUrl: string; account: string | null } | { kind: 'wait' } | { kind: 'renew'; message: string } | { kind: 'stop'; message: string }> {
    // 30s, not 10: the claim mints the agent, and a response lost to an early
    // timeout is recovered by the server replaying the same token anyway.
    const res = await this.fetchWithTimeout(`${serverUrl}/api/agent/pair-sessions/${encodeURIComponent(session.id)}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: session.secret }),
    }, 30_000);
    const j = (await res.json().catch(() => ({}))) as any;
    if (res.status === 403) {
      return { kind: 'stop', message: j?.error || "Your plan's computer limit is reached. Unlink a computer in the app or upgrade, then run this again." };
    }
    if (res.status === 404 || res.status === 409) return { kind: 'renew', message: 'That pairing code is no longer valid. Here is a new one.' };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (j?.status === 'paired' && typeof j.token === 'string' && typeof j.wsUrl === 'string') {
      return { kind: 'paired', token: j.token, wsUrl: j.wsUrl, account: typeof j.account === 'string' ? j.account : null };
    }
    if (j?.status === 'expired') return { kind: 'renew', message: 'The pairing code expired. Here is a new one.' };
    if (j?.status === 'declined') return { kind: 'renew', message: 'Pairing was declined on the phone. Here is a new code.' };
    return { kind: 'wait' };
  }

  private printPairSession(session: { code: string; pairUrl: string }): void {
    const qr = this.renderQr(session.pairUrl);
    console.log('');
    console.log('Scan this with your iPhone camera, or tap "Open camera" in the VibeKit app:');
    console.log('');
    console.log(qr ? qr.split('\n').map((line) => `  ${line}`).join('\n') : `  ${session.pairUrl}`);
    console.log('');
    if (session.code) console.log(`Can't scan? Tap "Type the code instead" and enter ${session.code}`);
    console.log('A new code appears on its own if this one expires. Press Ctrl+C to cancel.');
    console.log('');
    console.log('Waiting for your phone...');
  }

  /** Half-block QR sized for a terminal. Null if the renderer is missing, so the URL prints instead. */
  private renderQr(text: string): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const qrcode = require('qrcode-terminal') as { generate(t: string, o: { small?: boolean }, cb: (q: string) => void): void };
      let out: string | null = null;
      qrcode.generate(text, { small: true }, (q) => { out = q; });
      return out;
    } catch {
      return null;
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, ms = 10_000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Start the agent and connect to VibeKit
   */
  async start(directory: string, autoMode: boolean = false): Promise<void> {
    this.autoMode = autoMode;
    this.workingDirectory = path.resolve(directory);

    // Don't persist directory in auto mode (ephemeral container)
    if (!autoMode) {
      this.config.setLastDirectory(this.workingDirectory);
    }

    // No stored engine means this machine was linked before Codex support, so
    // it runs Claude, and is pinned to it now. Detecting here instead would
    // silently switch a user who relies on the npx Claude download and happens
    // to have Codex installed. Auto mode (Docker) is Claude-only and never
    // writes the config file.
    if (!autoMode && !this.config.getEngine()) this.config.setEngine('claude');
    this.engine = autoMode ? 'claude' : (this.config.getEngine() ?? 'claude');

    console.log(`Starting VibeKit Remote Agent...`);
    console.log(`Working directory: ${this.workingDirectory}`);
    console.log(`Engine: ${this.engine === 'codex' ? 'Codex' : 'Claude Code'}`);

    // In auto mode, set up Claude credentials from the credentials file.
    // Otherwise, sign Claude in from the user's VibeKit account if they've
    // connected it there — so they don't need a separate `claude setup-token`.
    if (autoMode) {
      await this.setupAutoModeCredentials();
    } else if (this.engine === 'claude') {
      await this.ensureAccountClaudeAuth();
    }

    if (this.engine === 'codex') {
      // A candidate only counts if `codex --version` runs, so a broken install
      // reads as not installed instead of failing every message.
      this.codexBinary = findCodexBinary();
      if (this.codexBinary) {
        console.log(`Codex found: ${this.codexBinary.path} (v${this.codexBinary.version})`);
        if (isOlderVersion(this.codexBinary.version, CODEX_TESTED_VERSION)) {
          console.log(`This Codex is older than v${CODEX_TESTED_VERSION}, the version VibeKit Remote was tested with. If messages fail, run: npm i -g @openai/codex@latest`);
        }
        // Said here so a user at the terminal can fix it before the first
        // message. The engine re-checks on each message, so logging in later
        // needs no restart.
        if (codexLoggedIn(this.codexBinary.path) === false) {
          console.log('Codex is not logged in on this computer. Run `codex login`; messages work as soon as you do.');
        }
      } else {
        console.log('\nCodex not found. Install it with `npm i -g @openai/codex`, then run `codex login`.');
      }
    } else {
      // Check for claude binary at startup
      const claudePath = findClaudeBinary();
      if (claudePath) {
        console.log(`Claude Code found: ${claudePath}`);
      } else {
        console.log('\nClaude Code not found locally — will auto-run via `npx @anthropic-ai/claude-code` on first message.');
        console.log('(First invocation downloads ~50MB and takes ~30s; cached thereafter.)');
        console.log('For a faster first message, install ahead of time: `claude install` or `npm install -g @anthropic-ai/claude-code`.\n');
      }
    }
    console.log('');

    // Prevent the laptop from idle-sleeping while the agent is running.
    // Without this, the macOS process gets suspended on sleep, the
    // WebSocket times out server-side, and the iOS Remote tab shows
    // "agent offline" until the laptop wakes. Lid-close sleep is still
    // unstoppable from userspace — this only blocks idle sleep.
    this.startCaffeinate();

    // Our MCP children call back on this port, and runClaude() bakes it into
    // the argv synchronously — so it has to be bound before the first message
    // can arrive, not on demand.
    await this.ensureControlServer();

    // Connect to VibeKit WebSocket
    this.connect();

    // Handle process signals
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    // Keep the process running
    await new Promise(() => {});
  }

  /**
   * Run claude command with the given prompt
   */
  private runClaude(prompt: string): void {
    // Find the claude binary
    const claudeBinary = findClaudeBinary();

    this.supersedeActiveRun();

    // Build command arguments
    const allowedTools = this.config.getAllowedTools();
    // --include-partial-messages: emit assistant message chunks as they arrive
    // instead of waiting for each full message. Without it, claude-cli batches
    // 100-500 chars per `assistant` event, so the iOS streaming bubble jumps in
    // chunks instead of smoothly typing — feels like nothing's happening for
    // a few seconds, then BAM the whole answer. Per-token streaming matches
    // the hosted-app chat UX.
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

    // Resume the prior conversation by EXACT session id when we have one.
    // Falls back to --continue for the first run after CLI start, which is
    // safe because there's no prior session to confuse it with. Mixing both
    // is documented as fine — Claude picks the explicit id over the cwd
    // search.
    if (this.currentSessionId) {
      args.push('--resume', this.currentSessionId);
      this.resumedSessionThisRun = true;
    } else if (this.hasActiveConversation) {
      args.push('--continue');
      this.resumedSessionThisRun = false;
    } else {
      this.resumedSessionThisRun = false;
    }

    // Fallback model: when the default is overloaded, claude transparently
    // retries on the fallback instead of failing the whole turn. Print-mode
    // only flag — exactly our case.
    args.push('--fallback-model', 'sonnet');

    // Defensive cap so a runaway tool loop (model decides to ls + cat the
    // entire filesystem) doesn't burn the user's quota silently. 50 turns is
    // far more than any normal chat needs; the rare task that legitimately
    // exceeds it can be split across messages.
    args.push('--max-turns', '50');

    // MCP plumbing. The SELF-CONFIG server is attached on every run, not just
    // supervised ones: "change your own settings" has to work in the default
    // posture, which is where nearly every user actually lives. Supervised
    // mode additionally attaches the permission-prompt server.
    let mcpConfigPath: string | null = null;
    let supervisedArmed = false;
    if (this.currentSupervised) {
      try {
        mcpConfigPath = this.ensureMcpPlumbing(true);
        supervisedArmed = true;
      } catch (e: any) {
        // Fail CLOSED into the old restricted behavior rather than silently
        // granting everything the user asked us to gate.
        console.error(`[Supervised] Could not start approval plumbing (${e?.message || e}) — running with tool restrictions instead.`);
      }
    } else {
      // A missing or broken config-mcp.js must never take down an ordinary
      // run, so this degrades to "no self-config this turn" rather than throw.
      // It SAYS so, though: swallowing the reason is what let a bind that
      // failed on every run look like a feature nobody had asked for.
      try {
        mcpConfigPath = this.ensureMcpPlumbing(false);
      } catch (e: any) {
        console.error(`[Self-config] Not attached this run (${e?.message || e}).`);
        mcpConfigPath = null;
      }
    }
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);

    /** An --allowedTools value that always keeps the self-config tools on it.
     *  See CONFIG_TOOL_NAMES for why this is not optional. */
    const allowList = (tools: string[]): string =>
      [...tools, ...(mcpConfigPath ? CONFIG_TOOL_NAMES : [])].join(',');

    if (supervisedArmed) {
      // Supervised mode: no skip-permissions. Every prompt claude would have
      // shown in a terminal routes through our MCP permission tool → parent
      // HTTP callback → WebSocket → the user's phone, which answers with
      // allow/deny (auto-deny after APPROVAL_TIMEOUT_MS). An explicit
      // allowedTools list still pre-approves those tools; everything else
      // gets prompted instead of refused.
      //
      // The flag is passed ONLY when the user already had a list, exactly as
      // before. Adding one where there was none would put this live safety
      // path into a state it has never run in, on an assumption about
      // claude-cli's precedence that is not worth testing in production. The
      // cost of not doing it is one extra tap to change a setting while
      // supervised, which is what "ask before actions" means anyway, and the
      // anti-lockout property still holds: an unlisted config tool prompts,
      // and the user can approve it.
      args.push('--permission-prompt-tool', 'mcp__vkapprove__approve');
      if (allowedTools.length > 0) args.push('--allowedTools', allowList(allowedTools));
      console.log('[Supervised] Permission prompts will be sent to your phone.');
    } else if (this.currentSupervised) {
      // Arming failed above — restricted fallback.
      args.push('--allowedTools', allowList(allowedTools.length > 0 ? allowedTools : ['Read', 'Grep', 'Glob', 'LS']));
    } else if (allowedTools.length === 0) {
      // No restrictions - allow everything
      args.push('--dangerously-skip-permissions');
    } else {
      // Use specific allowed tools
      args.push('--allowedTools', allowList(allowedTools));
    }

    // Model override. Unset (the default, and the only behaviour before this
    // key existed) leaves the choice to the user's claude install.
    const model = this.config.getModel();
    if (model) args.push('--model', model);

    // Decide how to launch claude:
    //   - local binary (installed) → spawn it directly (fast)
    //   - not installed → fall back to `npx --yes @anthropic-ai/claude-code`
    //     which auto-downloads on first run and caches thereafter. Keeps the
    //     agent usable out-of-the-box instead of dead-ending new users.
    let command: string;
    let spawnArgs: string[];
    if (claudeBinary) {
      command = claudeBinary;
      spawnArgs = args;
    } else {
      console.log('Claude Code not installed locally — falling back to `npx @anthropic-ai/claude-code` (first run downloads ~50MB).');
      // Let the user know to expect latency on first message.
      if (this.currentChatId) {
        this.sendResponse(
          this.currentChatId,
          '_Claude Code isn\'t installed yet — downloading it now (~30s one-time). Subsequent messages will be instant._',
          'streaming'
        );
      }
      command = 'npx';
      spawnArgs = ['--yes', '@anthropic-ai/claude-code', ...args];
    }
    // Log the invocation without echoing the user prompt.
    const redacted = spawnArgs.map((a, i, arr) => (arr[i - 1] === '-p' ? '"..."' : a)).join(' ');
    console.log(`\nRunning: ${command} ${redacted}`);

    // Every handler below closes over `run` and gates on
    // `this.activeRun === run`. A killed process's buffered stdout (and
    // its close event) fire AFTER the next run has been assigned — without
    // the gates, the old run's tail text leaked into the new run's buffer and
    // the old close handler nulled the NEW run, which disarmed Stop,
    // the 5-min kill timer, and the idle check that gates self-update.
    const proc = spawn(command, spawnArgs, {
      cwd: this.workingDirectory,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const run: ActiveRun = {
      engine: 'claude',
      stop: (force) => { try { proc.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ } },
    };
    this.beginRun(run);

    // Per-run UTF-8 decoder: a multibyte character (emoji, CJK, curly quote)
    // split across two stdout chunks decodes to U+FFFD with a plain
    // data.toString() — the corruption lands inside the JSON string, parses
    // fine, and "�" flows into the reply. StringDecoder buffers the partial
    // sequence across chunks.
    const stdoutDecoder = new StringDecoder('utf8');

    proc.stdout?.on('data', (data: Buffer) => {
      if (this.activeRun !== run) return; // superseded — not our buffer anymore
      const text = stdoutDecoder.write(data);
      // stream-json outputs one JSON object per line
      this.streamJsonLineBuffer += text;

      // Process complete lines
      const lines = this.streamJsonLineBuffer.split('\n');
      this.streamJsonLineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        this.processStreamJsonLine(line.trim());
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      process.stderr.write(text);
      if (this.activeRun !== run) return;
      // Keep the tail so the close handler can classify auth failures.
      this.lastRunStderr = (this.lastRunStderr + text).slice(-8192);
    });

    proc.on('close', (code) => {
      const settled = this.settleRun(run);
      console.log(`\nClaude exited with code ${code}`);
      if (!settled) return;

      // Process any remaining buffered line
      const tail = stdoutDecoder.end();
      if (tail) this.streamJsonLineBuffer += tail;
      if (this.streamJsonLineBuffer.trim()) {
        this.processStreamJsonLine(this.streamJsonLineBuffer.trim());
      }

      this.stopStreaming();
      // Cancel any pending debounced streaming frame NOW that the remaining
      // line has been processed — otherwise it fires up to 80ms after the
      // complete message below and repaints the closed streaming bubble.
      this.clearStreamingFlush();

      // Send final result. Error classification runs INDEPENDENTLY of whether
      // narration streamed first — a run that talked for a while and THEN died
      // on auth/an error used to be presented as a successful reply, skipping
      // the error message and the credential re-sync entirely.
      if (this.currentChatId && this.currentTelegramId) {
        let finalText = this.streamJsonResult.trim();
        const errText = this.lastRunResultError.trim();
        // The raw error string arrives twice: as the is_error `result`
        // (stashed, never forwarded) AND often as a plain text block that
        // flowed into the buffer — alone, or appended after real narration.
        // Strip the echo wherever it sits so it's never presented as a reply.
        if (finalText && errText && finalText.endsWith(errText)) {
          finalText = finalText.slice(0, finalText.length - errText.length).trim();
        }
        const toolCount = this.toolUseCountThisRun;
        if (this.looksLikeClaudeAuthFailure()) {
          // Auth problems are handled explicitly (message + creds re-sync)
          // even when narration streamed first. Send the narration as its own
          // bubble so watched work isn't lost, then the auth message.
          if (finalText) this.sendResponse(this.currentChatId, finalText, 'complete');
          void this.handleClaudeAuthFailure(this.currentChatId);
        } else if (errText) {
          // Real error — surface it, keeping any narration above it instead
          // of pretending the half-finished narration was the answer.
          const errLine = `Claude reported an error: ${errText.slice(0, 300)}`;
          const text = finalText ? `${finalText}\n\n_${errLine}_` : errLine;
          console.log(`[Agent] Run ended with error result (narration=${finalText.length} chars)`);
          this.sendResponse(this.currentChatId, text, 'complete');
        } else if (finalText) {
          console.log(`[Agent] Sending final response (${finalText.length} chars)`);
          this.sendResponse(this.currentChatId, finalText, 'complete');
        } else {
          // Claude exited without producing text. Don't claim success — be honest
          // so the user doesn't think we completed something we didn't.
          console.log(`[Agent] No result text collected, sending honest fallback (code=${code}, tools=${toolCount})`);
          this.sendResponse(this.currentChatId, this.noReplyFallback(code, toolCount), 'complete');
        }
      }

      this.activeRun = null;

      // Mark that we now have an active conversation for --continue on next message
      if (code === 0) {
        this.hasActiveConversation = true;
      } else if (this.resumedSessionThisRun) {
        // The run that just failed was a --resume <id>. If claude couldn't
        // load the session (JSONL pruned by the 30-day cleanup, --clear, disk
        // issue) every subsequent message would try the same dead id and
        // fail the same way. Clear it so the next attempt starts fresh
        // instead of locking the user into a loop. Note: if claude DID
        // start a new session before failing, processStreamJsonLine would
        // already have overwritten currentSessionId with the new id via
        // system/init — in that case this just confirms the old id is gone.
        console.log('[Agent] --resume run exited non-zero — clearing session id so the next message starts fresh');
        this.currentSessionId = null;
        this.hasActiveConversation = false;
      }
      this.resumedSessionThisRun = false;
    });

    proc.on('error', (err) => {
      console.error('Failed to start claude:', err.message);
      if (this.activeRun !== run) return;
      if (this.runTimeout) {
        clearTimeout(this.runTimeout);
        this.runTimeout = null;
      }
      this.cancelHeartbeats();
      this.stopStreaming();
      this.clearStreamingFlush();
      if (this.currentChatId && this.currentTelegramId) {
        this.sendResponse(
          this.currentChatId,
          `Error: Could not start Claude Code.\n\nPath: ${claudeBinary}\nError: ${err.message}`,
          'complete'
        );
      }
      // This run is over and has replied. Node may or may not emit 'close'
      // after a spawn 'error': marking it canceled stops a close from sending
      // a second, fallback reply, and releasing it here stops a missing close
      // from blocking every later message.
      this.canceledRuns.add(run);
      this.activeRun = null;
    });
  }

  /**
   * Stop whatever run is in flight because a new message is starting one.
   * handleUserMessage already sent a "canceled" reply to the old chat, and
   * marking the run canceled stops its end handler from sending a
   * misattributed fallback to the new chat.
   */
  private supersedeActiveRun(): void {
    if (this.activeRun) {
      this.canceledRuns.add(this.activeRun);
      this.activeRun.stop();
      this.denyAllPendingApprovals('Superseded by a new message.');
    }
    this.stopStreaming();
    this.clearStreamingFlush();
    this.currentMessageId = null;
  }

  /**
   * Bookkeeping every run shares, whichever engine runs it: it becomes the
   * active run, gets the hard kill timer, starts from clean per-run state and
   * gets the heartbeat statuses.
   */
  private beginRun(run: ActiveRun): void {
    this.activeRun = run;

    // Hard 5-min kill timer. Mirrors the server's SSE inactivity ceiling so
    // a wedged run (infinite bash loop, stuck API call, --continue session
    // corruption) doesn't block every subsequent message indefinitely. Power
    // users on multi-hour bash can disable with VIBEKIT_AGENT_NO_TIMEOUT=1.
    if (this.runTimeout) clearTimeout(this.runTimeout);
    if (!process.env.VIBEKIT_AGENT_NO_TIMEOUT) {
      const chatIdAtStart = this.currentChatId;
      this.runTimeout = setTimeout(() => {
        // Only act if THIS run is still the current one. A new message
        // may have replaced it, in which case the cancellation handler runs.
        if (this.activeRun !== run) return;
        console.log(`[Agent] ${run.engine} run exceeded ${AgentClient.RUN_TIMEOUT_MS / 1000}s, stopping`);
        if (chatIdAtStart) {
          this.sendResponse(
            chatIdAtStart,
            "_Run exceeded 5 minutes and was stopped. Try a smaller task or split it up._",
            'complete'
          );
        }
        // Mark canceled so the end handler doesn't double-send.
        this.canceledRuns.add(run);
        run.stop(true);
      }, AgentClient.RUN_TIMEOUT_MS);
    }

    // Per-run state. The names come from the Claude stream-json parser, but
    // the streaming flush and the no-reply fallback read them for every engine.
    this.streamJsonResult = '';
    this.lastRunResultError = '';
    this.lastRunStderr = '';
    this.receivedPartialDeltas = false;
    this.streamJsonLineBuffer = '';
    this.lastStreamedLength = 0;
    this.activeToolCalls.clear();
    this.toolUseCountThisRun = 0;
    // Heartbeat statuses fire if the engine is slow to produce anything
    // visible. Real activity (tool/delta) cancels them.
    this.scheduleHeartbeats();
  }

  /**
   * The shared start of a run's end. Returns false when there is nothing left
   * to send: the run was stopped on purpose (Stop, supersede, timeout), whose
   * stopper already messaged the chat, or it is no longer the active run.
   */
  private settleRun(run: ActiveRun): boolean {
    const isCurrent = this.activeRun === run;
    const wasCanceled = this.canceledRuns.has(run);
    this.canceledRuns.delete(run);

    // Timers and pending approvals belong to the CURRENT run — a superseded
    // run's slow exit must not clear the timers beginRun just armed for its
    // replacement, or deny the replacement's approval cards. The superseded
    // run's own approvals were denied when it was stopped.
    if (isCurrent) {
      this.denyAllPendingApprovals('The run ended before this was answered.');
      if (this.runTimeout) {
        clearTimeout(this.runTimeout);
        this.runTimeout = null;
      }
      this.cancelHeartbeats();
    }

    // Stopped on purpose: the stop site already messaged the chat.
    // Superseded-but-not-flagged: also nothing to do, the new run owns all
    // shared state.
    if (wasCanceled || !isCurrent) {
      if (isCurrent) this.activeRun = null;
      return false;
    }
    return true;
  }

  /** The honest reply for a run that produced no text, so it never reads as a success. */
  private noReplyFallback(exitCode: number | null, toolCount: number): string {
    if (exitCode !== 0) {
      return `Agent exited without a response (code ${exitCode}). Please try again.`;
    }
    if (toolCount > 0) {
      return `Agent finished after ${toolCount} tool call${toolCount === 1 ? '' : 's'} but didn't write a reply. Expand the tool calls above to see what was done, or send another message to continue.`;
    }
    return `Agent finished without producing a response. Try rephrasing or resending.`;
  }

  /**
   * Process a single line of stream-json output from Claude
   * Events include: system, assistant, tool_use, tool_result, result
   */
  private processStreamJsonLine(line: string): void {
    try {
      const event = JSON.parse(line);
      console.log(`[StreamJSON] type=${event.type}${event.subtype ? '/' + event.subtype : ''}`);
      
      switch (event.type) {
        case 'assistant': {
          // Assistant message - can contain text, tool_use blocks, or image blocks.
          // With --include-partial-messages on, streamJsonResult is already built
          // from content_block_delta events — skip re-concat to avoid duplicate
          // text. tool_use blocks still need handling (deltas don't carry the
          // full tool input + id we need for correlation).
          const msg = event.message;
          let appendedAny = false;
          if (msg?.content) {
            const content = Array.isArray(msg.content) ? msg.content : [msg.content];
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                if (!this.receivedPartialDeltas) {
                  this.ensureBlockSeparator();
                  this.streamJsonResult += block.text;
                  appendedAny = true;
                }
              } else if (block.type === 'tool_use') {
                // Tool call embedded in assistant message — carries the id we need for correlation
                this.handleToolUse(block.name, block.input || {}, block.id);
              }
              // Assistant messages don't generate new images — any image block here
              // is the model echoing a user-provided input back in context, which
              // shows up as the agent "replying" with the image you just sent.
              // Tool-result images (handleToolResult below) still forward.
            }
          } else if (msg?.type === 'text' && msg.text) {
            if (!this.receivedPartialDeltas) {
              this.ensureBlockSeparator();
              this.streamJsonResult += msg.text;
              appendedAny = true;
            }
          }
          // Live-stream the cumulative text to the iOS SSE consumer. iOS's
          // handleSSE replaces streamingText on each `text` event, so sending
          // the running total mirrors the chat-feels-instant UX you'd get
          // from a normal SDK stream. Throttled via scheduleStreamingFlush
          // so a burst of small deltas coalesces into one WS send per tick.
          if (appendedAny) {
            // Real text — drop any pending heartbeats.
            this.cancelHeartbeats();
            this.scheduleStreamingFlush();
          }
          break;
        }

        case 'user': {
          // Claude Code emits tool_result blocks wrapped in user messages
          const msg = event.message;
          const content = Array.isArray(msg?.content) ? msg.content : [];
          for (const block of content) {
            if (block?.type === 'tool_result') {
              this.handleToolResult(block.tool_use_id, block.content, block.is_error === true);
            }
          }
          break;
        }

        case 'tool_use': {
          // Standalone tool_use event (some Claude versions)
          const toolName = event.tool || event.name || '';
          const input = event.input || {};
          this.handleToolUse(toolName, input, event.id);
          break;
        }

        case 'content_block_start': {
          // Content block with tool_use
          const block = event.content_block;
          if (block?.type === 'tool_use') {
            this.handleToolUse(block.name, block.input || {}, block.id);
          }
          break;
        }

        // Legacy format
        case '_tool_use': {
          const toolName = event.tool || event.name || '';
          const input = event.input || {};
          this.handleToolUse(toolName, input, event.id);
          break;
        }

        case 'tool_result': {
          // Some stream-json variants emit standalone tool_result events
          this.handleToolResult(event.tool_use_id || event.id, event.content, event.is_error === true);
          break;
        }
        
        case 'result': {
          // Final result - collect the text
          if (event.result) {
            if (event.is_error === true) {
              // Claude surfaced an ERROR as its result (auth failures arrive as
              // subtype:"success" + is_error:true). Don't forward the raw CLI
              // string ("Invalid API key · Please run /login") — it's useless
              // in-app. Stash it for the run-end classifier instead of treating
              // it as a real reply.
              this.lastRunResultError = event.result;
            } else {
              // `result` carries ONLY the last assistant message (verified
              // against the CLI: a run that said "Alpha done.", called a tool,
              // then said "Beta done." has result = just the second message).
              // When the run streamed multiple text blocks, the accumulated
              // buffer is a superset ending in `result` — keep it, otherwise
              // the narration the user just watched vanishes from the
              // persisted reply. Replace only when the buffer doesn't already
              // end with the result (single-block runs, stale/empty buffer).
              // Whitespace-insensitive suffix compare: the buffer joins
              // blocks with our own "\n\n" while `result` joins them however
              // the CLI does — an exact endsWith would miss and drop the
              // watched narration over a newline difference.
              const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
              const acc = norm(this.streamJsonResult);
              const res = norm(String(event.result));
              if (!(acc && res && acc.endsWith(res))) {
                this.streamJsonResult = event.result;
              }
              this.scheduleStreamingFlush();
            }
          }
          if (event.subtype === 'success') {
            console.log('[StreamJSON] Task completed successfully');
          } else if (event.subtype === 'error') {
            console.log(`[StreamJSON] Task failed: ${event.error || 'unknown error'}`);
          }
          break;
        }
        
        case 'system': {
          // system/init: capture the session id so the NEXT run can use
          //   --resume <id> instead of --continue. See currentSessionId
          //   declaration for why this matters.
          // system/api_retry: surface to iOS so the user sees "Retrying..."
          //   instead of a long silence during rate-limit / overload backoff.
          // Everything else (plugin_install, etc.) is internal noise.
          if (event.subtype === 'init' && typeof event.session_id === 'string') {
            this.currentSessionId = event.session_id;
          } else if (event.subtype === 'api_retry') {
            const attempt = typeof event.attempt === 'number' ? event.attempt : 1;
            const max = typeof event.max_retries === 'number' ? event.max_retries : 1;
            const reason = typeof event.error === 'string' ? event.error.replace(/_/g, ' ') : 'transient error';
            this.sendStatusUpdate(`Retrying (${attempt}/${max}) — ${reason}…`);
          }
          break;
        }

        case 'rate_limit_event': {
          // Rate limit info from Claude — could surface this to user eventually
          const info = event.rate_limit_info;
          if (info?.status && info.status !== 'allowed') {
            console.log(`[StreamJSON] Rate limit: ${info.status} (${info.rateLimitType})`);
          }
          break;
        }

        case 'stream_event': {
          // Partial-message chunks from --include-partial-messages.
          // claude-cli wraps the Anthropic streaming API events in a
          // `stream_event` envelope. We care about content_block_delta with
          // text_delta — every other inner type (message_start, ping, etc.)
          // can be ignored since the final `assistant` / `result` events
          // still carry the full state.
          const inner = event.event;
          // A NEW text block is starting — separate it from whatever text the
          // previous block left in the buffer before its deltas arrive.
          if (inner?.type === 'content_block_start' && inner.content_block?.type === 'text') {
            this.ensureBlockSeparator();
          }
          if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
            const chunk = typeof inner.delta.text === 'string' ? inner.delta.text : '';
            if (chunk) {
              // First text — drop any pending heartbeats; we have something real to show now.
              if (!this.receivedPartialDeltas) this.cancelHeartbeats();
              this.streamJsonResult += chunk;
              this.receivedPartialDeltas = true;
              this.scheduleStreamingFlush();
            }
          }
          break;
        }

        default: {
          // Log unknown event types for debugging
          console.log(`[StreamJSON] Unknown event: ${JSON.stringify(event).substring(0, 200)}`);
          break;
        }
      }
    } catch (e) {
      // Not valid JSON - might be partial line or other output
      console.log(`[StreamJSON] Parse error: ${line.substring(0, 100)}`);
    }
  }

  /**
   * Claude emits SEPARATE text blocks per run (narration → tool calls → more
   * narration, each its own content block / assistant message). Appending them
   * with a bare += glues the new block's first word straight onto the previous
   * block's final period ("…done.Now I'll…"), which is how every multi-block
   * reply rendered on iOS/web. Insert a paragraph break between blocks; no-op
   * when the buffer is empty or already ends in whitespace.
   */
  private ensureBlockSeparator(): void {
    if (this.streamJsonResult && !/\s$/.test(this.streamJsonResult)) {
      this.streamJsonResult += '\n\n';
    }
  }

  /**
   * Stop streaming interval
   */
  private stopStreaming(): void {
    if (this.streamingInterval) {
      clearInterval(this.streamingInterval);
      this.streamingInterval = null;
    }
  }

  /**
   * Handle a tool_use event and send status update.
   * Tracks the call so the matching tool_result can be correlated later.
   */
  private handleToolUse(toolName: string, input: Record<string, any>, toolCallId?: string): void {
    // Real activity — drop any pending heartbeat statuses.
    this.cancelHeartbeats();
    if (toolCallId && toolName) {
      this.activeToolCalls.set(toolCallId, { name: toolName, input });
    }
    if (toolName) this.toolUseCountThisRun++;

    let statusText = '';

    if (toolName === 'Read' || toolName === 'ReadFile') {
      const filePath = input.file_path || input.path || '';
      statusText = `Read: ${this.truncatePath(filePath)}`;
    } else if (toolName === 'Write' || toolName === 'WriteFile') {
      const filePath = input.file_path || input.path || '';
      statusText = `Write: ${this.truncatePath(filePath)}`;
    } else if (toolName === 'Edit' || toolName === 'EditFile') {
      const filePath = input.file_path || input.path || '';
      statusText = `Edit: ${this.truncatePath(filePath)}`;
    } else if (toolName === 'Bash' || toolName === 'Execute') {
      const cmd = input.command || input.cmd || '';
      const shortCmd = cmd.length > 50 ? cmd.substring(0, 47) + '...' : cmd;
      statusText = `Bash: ${shortCmd}`;
    } else if (toolName === 'Glob' || toolName === 'ListFiles') {
      const pattern = input.pattern || '';
      statusText = pattern ? `Search: ${pattern}` : 'Search: files';
    } else if (toolName === 'Grep' || toolName === 'Search') {
      const pattern = input.pattern || input.query || '';
      statusText = `Grep: ${pattern.substring(0, 40)}`;
    } else if (toolName === 'WebSearch') {
      const query = input.query || '';
      statusText = `Search: ${query.substring(0, 40)}`;
    } else if (toolName === 'WebFetch') {
      const url = input.url || '';
      statusText = `Fetch: ${url.substring(0, 40)}`;
    } else if (toolName === 'Task') {
      statusText = `Task: sub-agent`;
    } else if (toolName) {
      statusText = toolName;
    }

    if (statusText) {
      console.log(`[Agent] Tool: ${toolName} -> ${statusText}`);
      this.sendStatusUpdate(statusText);
    }
  }

  /**
   * Handle a tool_result: extract text + image content, forward to server.
   */
  private handleToolResult(toolCallId: string | undefined, content: any, isError: boolean): void {
    if (!this.currentChatId) return;
    if (!toolCallId) return;

    const call = this.activeToolCalls.get(toolCallId);
    if (!call) {
      // Tool wasn't tracked (legacy stream, orphan result) — skip silently.
      return;
    }
    this.activeToolCalls.delete(toolCallId);

    let textOutput = '';
    const images: Array<{ mimeType: string; data: string }> = [];

    if (typeof content === 'string') {
      textOutput = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          textOutput += (textOutput ? '\n' : '') + block.text;
        } else if (block.type === 'image' && block.source) {
          const forwarded = this.forwardImageBlock(block.source, 'tool_result', toolCallId);
          if (forwarded) images.push(forwarded);
        }
      }
    }

    const maxBytes = AgentClient.TOOL_OUTPUT_MAX_BYTES;
    let outputTruncated = false;
    if (textOutput.length > maxBytes) {
      textOutput = textOutput.slice(0, maxBytes);
      outputTruncated = true;
    }

    this.send({
      type: 'tool_invocation',
      payload: {
        chatId: this.currentChatId,
        toolCallId,
        name: call.name,
        input: call.input,
        output: textOutput,
        isError,
        outputTruncated,
      },
      timestamp: Date.now(),
      messageId: this.generateId(),
    });

    if (images.length > 0) {
      console.log(`[Agent] tool_result ${call.name} produced ${images.length} image(s)`);
    }
  }

  /**
   * Emit an image_chunk for a Claude Code image content block.
   * Returns the forwarded image descriptor (useful for tool_result logging).
   */
  private forwardImageBlock(
    source: any,
    origin: 'assistant' | 'tool_result',
    toolCallId?: string
  ): { mimeType: string; data: string } | null {
    if (!this.currentChatId) return null;
    if (!source || source.type !== 'base64') return null;
    const mimeType = source.media_type || 'image/png';
    const data = typeof source.data === 'string' ? source.data : '';
    if (!data) return null;

    this.send({
      type: 'image_chunk',
      payload: {
        chatId: this.currentChatId,
        mimeType,
        data,
        source: origin,
        toolCallId,
      },
      timestamp: Date.now(),
      messageId: this.generateId(),
    });

    return { mimeType, data };
  }

  /**
   * Truncate file path for display
   */
  private truncatePath(filePath: string): string {
    if (filePath.length <= 40) return filePath;
    const parts = filePath.split('/');
    if (parts.length <= 2) return '...' + filePath.slice(-37);
    return '.../' + parts.slice(-2).join('/').slice(-36);
  }

  /**
   * Schedule heartbeat status messages for the current run. Fire at 1.5s
   * and 8s with progressively-worded statuses so the iOS UI shows life
   * during the gap between spawn and first delta/tool. Cancelled by
   * cancelHeartbeats() on first real activity.
   *
   * Wording is intentionally NOT "Thinking..." or "Working..." — the
   * server-side filter (`remote-agent.ts` handleStatus) drops those
   * exact strings as generic. Anything else passes through to the iOS
   * step list.
   */
  private scheduleHeartbeats(): void {
    this.cancelHeartbeats();
    this.heartbeatTimers.push(setTimeout(() => {
      this.sendStatusUpdate('Working on your request...');
    }, 1500));
    this.heartbeatTimers.push(setTimeout(() => {
      this.sendStatusUpdate('Generating response...');
    }, 8000));
  }

  /**
   * Cancel any pending heartbeat timers. Called when real activity (tool
   * use or text delta) lands — the heartbeat was just a "hey, alive" hint,
   * once we have real progress to show the heartbeat is noise.
   */
  private cancelHeartbeats(): void {
    for (const t of this.heartbeatTimers) clearTimeout(t);
    this.heartbeatTimers = [];
  }

  /**
   * Send status update to server (for live progress display)
   */
  private sendStatusUpdate(currentTask: string): void {
    if (!this.currentChatId) return;

    this.send({
      type: 'status',
      payload: {
        status: 'busy',
        workingDirectory: this.workingDirectory,
        currentTask,
        branch: this.currentGitBranch(),
      },
      timestamp: Date.now(),
      messageId: this.generateId(),
    });
  }

  /**
   * Best-effort git branch lookup for the current workingDirectory.
   * Surfaced on the iOS Remote tile so users see "vibekit · master"
   * style detail. Returns undefined for non-git dirs, detached-HEAD
   * states, or any failure mode — the field is optional in the
   * protocol and the server skips updating when missing.
   *
   * Uses execSync rather than reading .git/HEAD directly to handle
   * the worktree, submodule, and gitlink cases that a path-based read
   * would miss. Capped at 1.5s so a slow disk doesn't stall a
   * status broadcast.
   */
  private currentGitBranch(): string | undefined {
    try {
      const out = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.workingDirectory,
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!out || out === 'HEAD') return undefined;
      return out;
    } catch {
      return undefined;
    }
  }

  /**
   * Flush final buffered output to Telegram (legacy - kept for compatibility)
   */
  private flushOutput(): void {
    // With stream-json, final response is handled in the 'close' handler
    // This is kept as a no-op for any code paths that still call it
    this.currentMessageId = null;
  }

  /**
   * Connect to VibeKit WebSocket server
   */
  private connect(): void {
    const wsUrl = this.config.getWsUrl();
    const token = this.config.getToken();

    if (!wsUrl || !token) {
      console.error('No credentials found. Run "vibekit-agent link" first.');
      process.exit(1);
    }

    console.log('Connecting to VibeKit...');
    this.ws = new WebSocket(wsUrl);

    // Cap the handshake at 10s. Without this, a half-open TCP after wake
    // can leave the socket stuck in CONNECTING state for whatever the OS
    // timeout is (often minutes), blocking the reconnect loop. Cleared on
    // every terminal event below.
    //
    // `terminate()` on a socket still in CONNECTING is reported by ws as an
    // 'error' carrying a fixed message ("WebSocket was closed before the
    // connection was established"), emitted just before 'close'. That error
    // IS this watchdog firing, not a fault we hit, so it is flagged here and
    // read by the error handler below. Untagged, it reached prod's error log
    // at error level and was scraped into the admin Server Errors panel as an
    // unexplained failure, while the reconnect it triggered worked perfectly
    // (2026-08-16). Only this call site can produce it: the heartbeat and wake
    // watchdogs start inside 'open', so their terminate() always sees OPEN.
    let handshakeAborted = false;
    let handshakeTimer: NodeJS.Timeout | null = setTimeout(() => {
      handshakeTimer = null;
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        handshakeAborted = true;
        console.log('[Connect] Handshake timed out after 10s — terminating');
        try { this.ws.terminate(); } catch {}
      }
    }, 10_000);
    const clearHandshakeTimer = () => {
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
    };

    this.ws.on('open', () => {
      clearHandshakeTimer();
      console.log('Connected to VibeKit');
      this.isConnected = true;
      this.reconnectDelay = 1000;
      this.lastErrorWasDns = false;

      // Enable TCP keepalive on the underlying socket so the OS detects a
      // dead peer in ~2 min instead of the default ~2 hours, even if our
      // app-level heartbeat misses (e.g. event loop stalled mid-task).
      const sock = (this.ws as unknown as { _socket?: { setKeepAlive?: (enable: boolean, initialDelay: number) => void } })?._socket;
      if (sock?.setKeepAlive) {
        try { sock.setKeepAlive(true, 30_000); } catch {}
      }

      this.startHeartbeatWatchdog();
      this.startWakeWatchdog();

      // Authenticate
      this.send({
        type: 'auth',
        payload: {
          token,
          agentVersion: AGENT_VERSION,
          platform: os.platform(),
          workingDirectory: this.workingDirectory,
          branch: this.currentGitBranch(),
          // Additive: lets the phone show what this machine is set to without
          // waiting for a config change to happen. Deliberately NOT carrying
          // `supervised` — that one is the server's, and reporting our copy
          // on every reconnect would fight the iOS toggle.
          model: this.config.getModel() || null,
          allowedTools: this.reportedAllowedTools(),
          // Additive (2026-09-14): lets the phone label the machine. Servers
          // older than Codex support ignore it.
          engine: this.engine,
        },
        timestamp: Date.now(),
        messageId: this.generateId(),
      });
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as WSMessage;
        this.handleMessage(message);
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    });

    this.ws.on('close', () => {
      clearHandshakeTimer();
      console.log('Disconnected from VibeKit');
      this.isConnected = false;
      this.denyAllPendingApprovals('The phone disconnected.');
      this.stopHeartbeatWatchdog();
      this.stopWakeWatchdog();
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      clearHandshakeTimer();
      this.isConnected = false;
      this.denyAllPendingApprovals('The phone connection failed.');
      if (handshakeAborted) {
        // Our own 10s watchdog aborted this handshake and already logged why.
        // ws emits 'close' straight after, which schedules the reconnect, so
        // there is nothing to report and nothing more to do. Reset the flag so
        // a genuine error later on this socket is still logged.
        handshakeAborted = false;
        return;
      }
      console.error('WebSocket error:', error.message);
      const msg = error?.message || '';
      if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN')) {
        this.lastErrorWasDns = true;
        // Seed the OS resolver cache while the 10s reconnect floor counts
        // down. Without this the next attempt almost always re-ENOTFOUNDs
        // and we burn another backoff cycle (~20s offline). With it, ~10s.
        this.prewarmDns();
      }
    });
  }

  /**
   * Start a timer that watches for server silence. The server pings every 5s,
   * so if we haven't seen one in 60s the TCP is almost certainly dead — terminate
   * the socket and reconnect eagerly instead of waiting for the server's 240s
   * timeout (during which iOS sees us as offline).
   */
  private startHeartbeatWatchdog(): void {
    this.stopHeartbeatWatchdog();
    this.lastServerPingAt = Date.now();
    this.heartbeatWatchdog = setInterval(() => {
      const elapsed = Date.now() - this.lastServerPingAt;
      if (elapsed > AgentClient.SERVER_SILENCE_TIMEOUT_MS) {
        console.log(`[Heartbeat] Server silent for ${Math.round(elapsed / 1000)}s — reconnecting`);
        this.stopHeartbeatWatchdog();
        try { this.ws?.terminate(); } catch {}
        // .terminate() triggers 'close' which schedules reconnect for us.
      }
    }, AgentClient.WATCHDOG_INTERVAL_MS);
  }

  private stopHeartbeatWatchdog(): void {
    if (this.heartbeatWatchdog) {
      clearInterval(this.heartbeatWatchdog);
      this.heartbeatWatchdog = null;
    }
  }

  /**
   * Wake-from-sleep detector. setInterval doesn't tick while the host is
   * suspended, so a >5s gap between 1s ticks means the OS just paused us
   * (laptop lid closed, screensaver, etc.) and the WS is almost certainly
   * a zombie now. Tear it down immediately so the user's next message
   * doesn't have to wait 60s for the heartbeat watchdog to figure it out.
   */
  private startWakeWatchdog(): void {
    this.stopWakeWatchdog();
    this.lastWakeTickAt = Date.now();
    this.wakeWatchdog = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastWakeTickAt;
      this.lastWakeTickAt = now;
      if (gap > AgentClient.WAKE_GAP_THRESHOLD_MS) {
        console.log(`[Wake] Detected ${Math.round(gap / 1000)}s wall-clock gap — likely woke from sleep, forcing reconnect`);
        this.stopWakeWatchdog();
        this.stopHeartbeatWatchdog();
        // Bump the next reconnect delay to 5s so we don't waste two
        // attempts on getaddrinfo ENOTFOUND while macOS's network/DNS
        // stack is still resuming. Without this, the typical sequence is
        // 1s→fail→2s→fail→4s→ok = ~7s offline. With it, ~5s offline and
        // (almost always) succeeds on the first attempt.
        this.reconnectDelay = 5000;

        // Cancel any reconnect timer that was already scheduled (e.g. by
        // the heartbeat watchdog firing first). Without this, the timer
        // keeps its old — possibly long — backoff delay and our 5s
        // wake-fast-path is silently a no-op. Clearing it lets the close
        // handler below schedule a fresh 5s timer.
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }

        // Pre-warm DNS while the 5s reconnect timer counts down. macOS's
        // resolver typically takes 60-90s to fully recover after a network
        // change, but a hint lookup right now seeds the cache so the actual
        // WS handshake skips the ENOTFOUND retry storm.
        this.prewarmDns();

        try { this.ws?.terminate(); } catch {}
        // .terminate() triggers 'close' which schedules reconnect for us.
      }
    }, AgentClient.WAKE_TICK_INTERVAL_MS);
  }

  private stopWakeWatchdog(): void {
    if (this.wakeWatchdog) {
      clearInterval(this.wakeWatchdog);
      this.wakeWatchdog = null;
    }
  }

  /**
   * Fire-and-forget DNS resolve for the WS host. The OS resolver caches
   * the result for ~30s; the upcoming WS handshake hits the warm cache
   * and skips the cold-start ENOTFOUND that almost always greets the
   * first post-wake reconnect attempt on macOS.
   */
  private prewarmDns(): void {
    try {
      const wsUrl = this.config.getWsUrl();
      if (!wsUrl) return;
      const host = new URL(wsUrl).hostname;
      dns.lookup(host, () => {});
    } catch {}
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(message: WSMessage): void {
    switch (message.type) {
      case 'auth_success': {
        // Server can return the user-set display name for this agent
        // (Phase 4 multi-remote-agents). Surface it on stdout so the
        // user knows which paired machine this CLI represents — handy
        // when juggling multiple terminals across laptop + remote box.
        const payload = message.payload as { telegramId: number; agentName?: string; latestAgentVersion?: string } | undefined;
        const label = payload?.agentName?.trim();
        if (label) {
          console.log(`Authenticated as "${label}"`);
        } else {
          console.log('Authenticated successfully');
        }
        console.log('');
        console.log('Ready! Send messages from the Remote tab in the VibeKit app.');
        console.log('Press Ctrl+C to stop.');
        console.log('');
        this.sendStatus('idle');
        // Replay anything we couldn't send while the WS was down — the tail
        // of a turn that finished mid-disconnect lands here on reconnect.
        this.flushOutboundQueue();
        // The server tells us the latest published version on every auth.
        // If we're behind, update + restart ourselves so the user never has
        // to copy-paste a command on the machine. Best-effort, fire-and-forget.
        void this.maybeSelfUpdate(payload?.latestAgentVersion);
        break;
      }

      case 'auth_error': {
        // Deleting the stored token is IRREVERSIBLE from this machine (the
        // user has to fetch a fresh link code from their phone), so it only
        // happens when the server explicitly says the token itself is bad.
        // Servers ≥2026-08-02 stamp that case code:'invalid_token'; anything
        // else (or a legacy server's bare auth_error) is treated as
        // transient: keep the token, exit, and let the supervisor/user
        // restart into a normal reconnect. Before this gate, a server-side
        // DB blip during auth wiped the token and pm2 crash-looped
        // "No token found" 43k times (2026-08-01).
        const payload = (message.payload as { message: string; code?: string }) || { message: 'unknown' };
        if (payload.code === 'invalid_token') {
          // The designed revocation path, not a failure: the machine was
          // unlinked in the app (the only way a pairing ends), or its row
          // was replaced. Said on stdout. Supervisors treat stderr as
          // errors, and our own box's pm2 error log feeds the admin Remote
          // Errors panel, where a deliberate unlink showed up as a server
          // error (2026-09-15).
          console.log('This machine was unlinked from VibeKit, so its pairing is no longer valid. Run "vibekit-agent link" with a fresh code from the app.');
          this.config.clear();
        } else {
          console.error('Authentication failed:', payload.message);
          console.error('Keeping the stored pairing — this looks like a temporary server problem. Retrying shortly...');
          // Don't exit: schedule a normal reconnect like a dropped socket.
          this.scheduleReconnect();
          break;
        }
        process.exit(1);
        break;
      }

      case 'message':
        this.handleUserMessage(message as UserMessage);
        break;

      case 'ping':
        // Record the server's liveness — watchdog uses this to detect dead TCP.
        this.lastServerPingAt = Date.now();
        this.send({ type: 'pong', timestamp: Date.now(), messageId: this.generateId() });
        break;

      case 'cd':
        this.handleCdCommand((message.payload as { path: string }).path);
        break;

      case 'new_conversation':
        this.handleNewConversation();
        break;

      case 'list_sessions':
        this.handleListSessions((message.payload as { requestId?: string }) || {});
        break;

      case 'resume_session':
        this.handleResumeSession((message.payload as { requestId?: string; sessionId?: string }) || {});
        break;

      case 'cancel':
        // Explicit user Stop from iOS/Telegram. Before this existed the app's
        // Stop button was client-side only — the Claude run kept going on the
        // agent machine (visible again on window re-open) until it finished
        // or hit the 5-min hard kill.
        this.handleCancel();
        break;

      case 'write_env':
        this.handleWriteEnv((message.payload as { envVars: { key: string; value: string }[] }).envVars);
        break;

      case 'permission_response': {
        const { requestId, behavior, message: denyMessage } =
          (message.payload as { requestId: string; behavior: 'allow' | 'deny'; message?: string }) || {};
        this.resolveApproval(requestId, behavior === 'allow' ? 'allow' : 'deny', denyMessage);
        break;
      }

      case 'streaming_ack':
        // Server acknowledged streaming message and sent back Telegram messageId
        const ack = message.payload as { messageId: number };
        if (ack.messageId) {
          this.currentMessageId = ack.messageId;
        }
        break;

      default:
        // Ignore unknown messages
        break;
    }
  }

  /**
   * Auto-update: when the server reports a newer published version than the
   * one we're running, install it and restart to load it — so the user can
   * update entirely from their phone instead of copy-pasting a command on the
   * machine. Best-effort and conservative:
   *   - skipped in auto mode (ephemeral containers reinstall per run, and a
   *     mid-build restart would kill the task)
   *   - skipped when a Claude run is in flight (we'd interrupt it); a later
   *     reconnect retries, so we intentionally DON'T set updateAttempted here
   *   - opt-out with VIBEKIT_AGENT_NO_AUTOUPDATE=1
   *   - runs at most once per process, even across reconnect storms
   * An install failure (e.g. a global npm dir needing sudo) is logged and we
   * stay on the current version — the iOS tile's "Update" badge still nudges
   * the manual path, so nothing regresses.
   */

  /**
   * True when `candidate` is a strictly higher release than `current`.
   * Deliberately fail-closed: anything unparseable (prerelease tags, empty
   * strings, 'unknown' from a failed package.json read) returns false, so a
   * malformed version can never trigger an update-and-restart cycle.
   */
  private static isNewerVersion(candidate: string, current: string): boolean {
    const parse = (v: string): [number, number, number] | null => {
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const a = parse(candidate);
    const b = parse(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
  }

  private async maybeSelfUpdate(latest?: string): Promise<void> {
    if (process.env.VIBEKIT_AGENT_NO_AUTOUPDATE) return;
    if (this.autoMode) return;
    // Only ever move FORWARD. This used to be `latest !== AGENT_VERSION`,
    // which treats "the server's cached latest is OLDER than what I run" as
    // an update: the agent then reinstalls @latest (a no-op), restarts, and
    // the fresh process repeats the whole dance, because updateAttempted is
    // per-process. That is an unbounded restart loop, and it fired for real
    // when a deploy restarted the server minutes before a publish, leaving
    // its hourly npm cache one version behind the agent (2026-08-02, 17
    // restarts in 20s). A stale or rolled-back cache must be a no-op.
    if (!latest || !AgentClient.isNewerVersion(latest, AGENT_VERSION)) return;
    if (this.updateAttempted) return;
    if (this.activeRun) {
      // Busy — don't interrupt a run. Leave updateAttempted unset so the next
      // reconnect (or the next idle auth) tries again.
      console.log(`[Auto-update] v${latest} available but a task is running — will update when idle.`);
      return;
    }
    this.updateAttempted = true;
    console.log(`\n[Auto-update] New version available: v${AGENT_VERSION} -> v${latest}. Installing...`);
    // NOTE: installs the `latest` dist-tag, not a pinned `@${latest}` — the
    // registry is the authority on what "latest" resolves to.

    execFile(
      'npm',
      ['install', '-g', 'vibekit-agent@latest'],
      { timeout: 180_000, env: process.env },
      (err, _stdout, stderr) => {
        if (err) {
          // npm's stderr is dozens of "npm error" lines; dumping a tail of it
          // put one phantom UNCAUGHT row PER LINE on the admin failures panel
          // (29 rows for one EACCES on 2026-08-01). Distill to the lines that
          // identify the failure and emit exactly one log line.
          const gist = (stderr || '')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => /^npm error (code|syscall|path|errno|Error:)/.test(l))
            .map((l) => l.replace(/^npm error\s*/, ''))
            .slice(0, 4)
            .join(' | ');
          console.error(`[Auto-update] Install failed: ${err.message}${gist ? ` (${gist})` : ''}. Staying on v${AGENT_VERSION}. Update manually with: npm install -g vibekit-agent@latest`);
          return;
        }
        console.log(`[Auto-update] Installed v${latest}. Restarting to load it...`);
        this.restartForUpdate(latest);
      },
    );
  }

  /**
   * Restart this process so the freshly-installed code takes over.
   *   - Under pm2 (pm_id/PM2_HOME set): just exit — pm2 re-forks the script,
   *     which now points at the updated files on disk.
   *   - Otherwise (bare terminal, nohup, tmux/screen): spawn a DETACHED copy
   *     with the same argv (start [-d dir] …) — argv[1] is the global bin that
   *     npm just overwrote in place, so the child loads the new code — then
   *     exit. The server drops the stale connection when the child re-auths
   *     with the same token.
   * A systemd unit with Restart= behaves like pm2 (the detached child is
   * killed with the cgroup on exit, then systemd restarts the unit fresh).
   */
  private restartForUpdate(latest: string): void {
    const underPm2 = process.env.pm_id != null || !!process.env.PM2_HOME;
    if (!underPm2) {
      try {
        const child = spawn(process.execPath, process.argv.slice(1), {
          cwd: process.cwd(),
          env: process.env,
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
      } catch (e: any) {
        console.error(`[Auto-update] Could not spawn the replacement process: ${e?.message || e}. Exiting — restart the agent to run v${latest}.`);
      }
    }
    // Let the last WS frames flush, then exit so the replacement (or the
    // supervisor) takes over the connection.
    setTimeout(() => process.exit(0), 500);
  }

  /**
   * Handle user message from Telegram or iOS app
   */
  private handleUserMessage(message: UserMessage): void {
    const { chatId, text, telegramId, messageId, attachments, supervised } = message.payload;
    this.currentSupervised = !!supervised && !this.autoMode;

    // If a previous run is still in flight when a new message arrives, send
    // a "canceled" acknowledgment to ITS chatId before we overwrite
    // currentChatId. Pre-2026-05-09 this was a silent SIGTERM (in
    // runClaude) — the user's first message bubble + spinner just hung
    // forever with no signal. Now they see an explicit cancellation in
    // the original chat and the new message proceeds normally.
    if (this.activeRun && this.currentChatId && this.currentChatId !== chatId) {
      this.sendResponse(
        this.currentChatId,
        "_Canceled — you sent a new message before this one finished._",
        'complete'
      );
    }

    this.currentChatId = chatId;
    this.currentTelegramId = telegramId;
    this.currentReplyToMessageId = messageId;

    let prompt = text || '';
    // Codex gets images as real inputs (localImage), on top of the path in the prompt.
    const imagePaths: string[] = [];
    const attachmentInfo = attachments?.length ? ` with ${attachments.length} attachment(s)` : '';
    console.log(`\nReceived: ${text || '(no text)'}${attachmentInfo}`);

    // Process attachments if present
    if (attachments && attachments.length > 0) {
      const savedFiles = this.saveAttachments(attachments);

      if (savedFiles.length > 0) {
        // Build prompt with attachment references
        for (const file of savedFiles) {
          if (file.type === 'voice') {
            // For voice, ask Claude to listen and respond
            prompt = `[Voice message saved to: ${file.path}]\n\nPlease listen to this voice message and respond to it.\n\n${prompt}`.trim();
          } else if (file.type === 'image') {
            // For images, ask Claude to analyze
            prompt = `[Image saved to: ${file.path}]\n\nPlease analyze this image.\n\n${prompt}`.trim();
            imagePaths.push(file.path);
          } else {
            // For documents, mention the file
            prompt = `[File saved to: ${file.path}]\n\n${prompt}`.trim();
          }
        }
      }
    }

    // Ensure we have something to process
    if (!prompt.trim()) {
      this.sendResponse(chatId, 'No message content received.', 'complete');
      return;
    }

    this.sendStatus('busy');

    // Send an immediate progress signal so the iOS chat doesn't sit on a
    // bare "thinking" indicator for 5-30s during Claude Code spawn / cold
    // model load. The first real `assistant` text event will overwrite this
    // (handleSSE replaces streamingText on each `text` event). Without it,
    // a slow spawn looks identical to a hung agent.
    this.sendStreaming(chatId, 'Starting…');

    // Run the engine (its events send status updates)
    if (this.engine === 'codex') {
      this.runCodex(prompt, imagePaths);
    } else {
      this.runClaude(prompt);
    }
  }

  /**
   * Run one Codex turn through app-server. Shares the run bookkeeping with
   * runClaude (supersedeActiveRun, beginRun, settleRun), so Stop, supersede,
   * the run timeout and the self-update idle check behave the same. Every
   * event mapping is in codex-translate.ts.
   */
  private runCodex(prompt: string, imagePaths: string[]): void {
    this.supersedeActiveRun();
    const chatId = this.currentChatId;

    // Looked up again while missing, so installing Codex works from the next message.
    if (!this.codexBinary) this.codexBinary = findCodexBinary();
    const binary = this.codexBinary;
    if (!binary) {
      if (chatId) this.sendResponse(chatId, CODEX_NOT_INSTALLED, 'complete');
      return;
    }
    if (!this.codex || this.codex.binary !== binary.path) {
      this.codex?.dispose();
      this.codex = new CodexEngine(binary.path, AGENT_VERSION);
    }
    const codex = this.codex;

    let stopTurn: (() => void) | null = null;
    const run: ActiveRun = { engine: 'codex', stop: () => stopTurn?.() };
    this.beginRun(run);

    const access = codexAccessFor(this.config.getAllowedTools(), this.currentSupervised);
    const cwd = this.workingDirectory;
    const turn = codex.startTurn({
      prompt,
      imagePaths,
      cwd,
      model: this.config.getModel(),
      access,
      mcpServers: () => this.codexMcpServers(codex, access, cwd),
    }, {
      output: (o) => {
        if (this.activeRun !== run || this.canceledRuns.has(run)) return;
        this.cancelHeartbeats();
        if (o.kind === 'text') {
          this.streamJsonResult = o.text;
          this.scheduleStreamingFlush();
        } else if (o.kind === 'status') {
          this.sendStatusUpdate(o.text);
        } else if (this.currentChatId) {
          this.send({
            type: 'tool_invocation',
            payload: { chatId: this.currentChatId, ...o.tool },
            timestamp: Date.now(),
            messageId: this.generateId(),
          });
        }
      },
      approve: async (toolName, input) => {
        if (this.activeRun !== run || this.canceledRuns.has(run)) return false;
        return (await this.askPhone(toolName, input)).behavior === 'allow';
      },
    });
    stopTurn = turn.stop;
    void turn.done.then((end) => this.endCodexRun(run, end, codex));
  }

  private endCodexRun(run: ActiveRun, end: CodexTurnEnd, codex: CodexEngine): void {
    const settled = this.settleRun(run);
    console.log(`\nCodex turn ended: ${end.status}${end.error ? ` (${end.error.info})` : ''}`);
    if (!settled) return;
    this.stopStreaming();
    this.clearStreamingFlush();

    if (this.currentChatId && this.currentTelegramId) {
      const narration = end.text.trim();
      if (end.status === 'completed') {
        const reply = this.sendLinkedImages(this.currentChatId, narration);
        this.sendResponse(this.currentChatId, reply || this.noReplyFallback(0, end.toolCount), 'complete');
      } else {
        // A normal `complete` reply, never `status: 'error'`: iOS rewrites the
        // text of SSE error events with Claude-specific help, on every build
        // in the wild. Narration the user watched stays above the error.
        const errLine = end.error
          ? codexErrorReply(end.error, { resetsAtSec: codex.rateLimitResetsAtSec, testedVersion: CODEX_TESTED_VERSION })
          : 'Codex ended this run before it finished. Send your message again.';
        this.sendResponse(this.currentChatId, narration ? `${narration}\n\n_${errLine}_` : errLine, 'complete');
      }
    }
    this.activeRun = null;
  }

  /**
   * Send the local images a reply links to (local-images.ts) ahead of the
   * reply, which iOS needs to attach them to it, and return the reply with
   * each sent link reduced to its caption. The user's own attachments are
   * never echoed back, the same rule as Claude's assistant image blocks.
   */
  private sendLinkedImages(chatId: number, text: string): string {
    const canonicalPath = (target: string): string => {
      try { return fs.realpathSync(target); } catch { return path.resolve(target); }
    };
    const attachmentsDir = canonicalPath(path.join(this.workingDirectory, '.vibekit-attachments')) + path.sep;
    const sent = new Set<string>();
    let reply = text;
    for (const ref of localImageRefs(text)) {
      const imagePath = canonicalPath(ref.path);
      if (imagePath.startsWith(attachmentsDir)) continue;
      if (!sent.has(imagePath)) {
        const image = readImageForPhone(ref.path);
        if (!image) continue;
        this.send({
          type: 'image_chunk',
          payload: { chatId, mimeType: image.mimeType, data: image.data, source: 'assistant' },
          timestamp: Date.now(),
          messageId: this.generateId(),
        });
        sent.add(imagePath);
      }
      reply = reply.replace(ref.markdown, () => ref.alt); // a function, so `$&` in a caption stays literal
    }
    return reply.trim();
  }

  /** Per-thread MCP tools. Read-only mode gets filesystem readers because its native shell is disabled. */
  private codexMcpServers(codex: CodexEngine, access: CodexAccess, cwd: string): Record<string, McpServerSpec> {
    const configScript = path.join(__dirname, 'config-mcp.js');
    const servers: Record<string, McpServerSpec> = {};
    if (this.controlPort && fs.existsSync(configScript)) {
      servers[VKCONFIG_SERVER] = {
        command: process.execPath,
        args: [configScript],
        env: { VK_CONFIG_PORT: String(this.controlPort), VK_ENGINE: 'codex', VK_MODELS: codex.models.join(',') },
        // The config tools never need a tap, the same as CONFIG_TOOL_NAMES on
        // Claude; a loosening already asks the phone inside the tool itself.
        // 'approve', not 'auto': measured live on Codex 0.154.0, 'auto' still
        // requires approval (an elicitation when supervised, a hard failure
        // under approvalPolicy never), 'approve' runs the tool.
        approvalMode: 'approve',
      };
    }
    const readScript = path.join(__dirname, 'codex-read-mcp.js');
    if (access === 'read-only' && fs.existsSync(readScript)) {
      servers.vkread = {
        command: process.execPath,
        args: [readScript],
        env: { VK_READ_ROOT: cwd },
        // Read-only runs under approvalPolicy never, where a tool that needs
        // approval simply fails: with 'auto' every read failed in the live test.
        approvalMode: 'approve',
      };
    }
    return servers;
  }

  /** The tool list the phone is shown: the raw list for Claude, and for Codex the access actually in force. */
  private reportedAllowedTools(): string[] {
    const tools = this.config.getAllowedTools();
    return this.engine === 'codex' ? codexReportedTools(tools) : tools;
  }

  /**
   * Save attachments to temp directory and return file paths
   */
  private saveAttachments(attachments: MessageAttachment[]): { type: string; path: string }[] {
    const savedFiles: { type: string; path: string }[] = [];

    // Create temp directory in working directory
    const attachmentsDir = path.join(this.workingDirectory, '.vibekit-attachments');
    if (!fs.existsSync(attachmentsDir)) {
      fs.mkdirSync(attachmentsDir, { recursive: true });
    }

    for (const attachment of attachments) {
      try {
        // Decode base64 data
        const buffer = Buffer.from(attachment.data, 'base64');

        // Generate unique filename
        const timestamp = Date.now();
        const filename = `${timestamp}-${attachment.filename}`;
        const filePath = path.join(attachmentsDir, filename);

        // Write file
        fs.writeFileSync(filePath, buffer);
        console.log(`Saved ${attachment.type}: ${filePath}`);

        savedFiles.push({
          type: attachment.type,
          path: filePath,
        });
      } catch (error) {
        console.error(`Failed to save attachment ${attachment.filename}:`, error);
      }
    }

    return savedFiles;
  }

  /**
   * Handle new conversation command - reset conversation memory
   */
  private handleNewConversation(): void {
    this.hasActiveConversation = false;
    this.currentSessionId = null;
    this.codex?.resetThread();
    console.log('Conversation reset - next message will start fresh');
  }

  /**
   * The Claude sessions saved for the current folder, for the phone's "Continue
   * a session from this computer" list (claude-sessions.ts). Codex threads are
   * not listed yet; the reply says which engine is active so the phone can say so.
   */
  private handleListSessions(payload: { requestId?: string }): void {
    let sessions: ReturnType<typeof listClaudeSessions> = [];
    if (this.engine === 'claude') {
      try { sessions = listClaudeSessions(this.workingDirectory); } catch (e: any) { console.log(`[Agent] Listing sessions failed: ${e?.message || e}`); }
    }
    this.send({
      type: 'sessions_list',
      payload: { requestId: payload.requestId, engine: this.engine, cwd: this.workingDirectory, currentSessionId: this.currentSessionId, sessions },
      timestamp: Date.now(),
      messageId: this.generateId(),
    });
  }

  /**
   * Point the next message at a session from this folder: the same --resume
   * every message already uses, with an id the person picked. Refused while a
   * run is in flight, so a turn never changes session halfway.
   */
  private handleResumeSession(payload: { requestId?: string; sessionId?: string }): void {
    const reply = (body: Record<string, unknown>) => this.send({
      type: 'session_resumed',
      payload: { requestId: payload.requestId, ...body },
      timestamp: Date.now(),
      messageId: this.generateId(),
    });
    if (this.engine !== 'claude') return reply({ ok: false, error: 'not_claude' });
    if (this.activeRun) return reply({ ok: false, error: 'busy' });
    const file = claudeSessionFile(this.workingDirectory, String(payload.sessionId || ''));
    if (!file) return reply({ ok: false, error: 'not_found' });
    let recent: ReturnType<typeof recentClaudeTurns> = [];
    try { recent = recentClaudeTurns(file); } catch (e: any) { console.log(`[Agent] Reading the session's last turns failed: ${e?.message || e}`); }
    this.currentSessionId = String(payload.sessionId);
    this.hasActiveConversation = true;
    console.log(`Resumed session ${this.currentSessionId} from ${this.workingDirectory}`);
    reply({ ok: true, sessionId: this.currentSessionId, cwd: this.workingDirectory, recent });
  }

  /**
   * Explicit Stop from the app. Kill the in-flight Claude run (if any),
   * acknowledge to the chat so the transcript shows the stop, and flip
   * status back to idle so tiles/status endpoints don't keep saying
   * "working". Mirrors the supersede-by-new-message path: claudeWasCanceled
   * suppresses the close handler's "exited without response" double-send.
   */

  // ── Supervised-mode approval plumbing ──────────────────────────────

  /**
   * Bind (once) the localhost HTTP server our MCP children call back on.
   *
   * Awaited at startup rather than done inline where it is needed, because
   * binding is ASYNCHRONOUS: `listen(0, '127.0.0.1')` resolves the host
   * through dns.lookup first, so `server.address()` on the next line is null.
   * The inline version read it there and threw "control server failed to
   * bind" on every single run — which the caller swallowed, so self-config
   * (and supervised mode's approval prompts) silently never attached from the
   * day they shipped. runClaude() is synchronous and cannot await, so the
   * port has to already exist by the time it builds the argv.
   *
   * Resolves either way: a box that cannot bind loopback still gets a working
   * agent, minus self-config, and is told so rather than failing to start.
   */
  private ensureControlServer(): Promise<void> {
    if (this.controlServer) return Promise.resolve();
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handleControlHttpRequest(req, res));
      server.once('error', (e: any) => {
        console.error(`Self-config and supervised mode are unavailable: control server could not bind (${e?.message || e}).`);
        resolve();
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') {
          this.controlPort = addr.port;
          this.controlServer = server;
        }
        server.unref(); // never keep the process alive on its own
        resolve();
      });
    });
  }

  /**
   * Write the --mcp-config file pointing claude at our MCP children. Returns
   * the config path, or null when there is no MCP server worth attaching.
   *
   * `withApproval` adds the supervised-mode permission-prompt server. Throws
   * when the plumbing it needs is missing: a missing approval-mcp.js must
   * fail CLOSED (runClaude falls back to tool restrictions), while a missing
   * config-mcp.js just means no self-config this run.
   */
  private ensureMcpPlumbing(withApproval: boolean): string | null {
    const approveScript = path.join(__dirname, 'approval-mcp.js');
    const configScript = path.join(__dirname, 'config-mcp.js');
    if (withApproval && !fs.existsSync(approveScript)) throw new Error(`missing ${approveScript}`);
    const withConfig = fs.existsSync(configScript);
    if (!withApproval && !withConfig) return null;

    if (!this.controlPort) throw new Error('control server is not listening');

    // Port is baked into the config env, so rewrite whenever it changes
    // (fresh process = fresh ephemeral port). Rewritten per run rather than
    // once, because which servers belong in it depends on supervised mode:
    // declaring vkapprove outside supervised mode would offer claude a tool
    // that is never the right thing to call.
    if (!this.mcpConfigPath) {
      this.mcpConfigPath = path.join(os.tmpdir(), `vibekit-mcp-${process.pid}.json`);
    }
    const mcpServers: Record<string, unknown> = {};
    if (withApproval) {
      mcpServers.vkapprove = {
        command: process.execPath,
        args: [approveScript],
        env: { VK_APPROVAL_PORT: String(this.controlPort) },
      };
    }
    if (withConfig) {
      mcpServers.vkconfig = {
        command: process.execPath,
        args: [configScript],
        env: { VK_CONFIG_PORT: String(this.controlPort) },
      };
    }
    fs.writeFileSync(this.mcpConfigPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
    return this.mcpConfigPath;
  }

  /** Router for the two things our MCP children POST back to us. */
  private handleControlHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || (req.url !== '/approve' && req.url !== '/config')) {
      res.writeHead(404).end();
      return;
    }
    const isConfig = req.url === '/config';
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64_000) req.destroy(); });
    req.on('end', () => {
      let parsed: any = {};
      try { parsed = JSON.parse(body); } catch { /* keep defaults */ }
      const reply = (payload: unknown) => {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        } catch { /* MCP child already gone — claude was killed */ }
      };

      if (isConfig) {
        // The rejection arm matters: an unhandled throw would never call
        // reply(), and the MCP child would sit on its 200s socket timeout
        // with claude blocked behind it. An error is a far better failure
        // than a three-minute hang.
        void this.handleConfigToolCall(parsed).then(reply, (e: any) => {
          console.error(`[Config] handler threw: ${e?.message || e}`);
          reply({ ok: false, text: 'The agent hit an error applying that, so nothing changed.' });
        });
        return;
      }

      const toolName = typeof parsed?.toolName === 'string' ? parsed.toolName : 'unknown tool';
      const input = (parsed?.input && typeof parsed.input === 'object') ? parsed.input : {};
      // Trim the input we ship to the phone: a Write's full content can be
      // hundreds of KB; the card only needs enough to decide.
      const slim: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        slim[k] = typeof v === 'string' && v.length > 2_000 ? v.slice(0, 2_000) + '…' : v;
      }
      void this.askPhone(toolName, slim).then(reply);
    });
  }

  /**
   * Put a question on the user's phone and wait for the answer. Used by the
   * supervised-mode tool prompt and by a config change that would reduce
   * safety, so both share one deadline, one cancel path, and one card.
   * Resolves to a deny (never rejects) when there is no phone to ask.
   */
  private askPhone(toolName: string, input: Record<string, unknown>): Promise<PhoneDecision> {
    const chatId = this.currentChatId;
    if (!chatId || !this.isConnected) {
      return Promise.resolve({ behavior: 'deny', message: 'VibeKit is not connected, so no one could approve this.' });
    }
    return new Promise<PhoneDecision>((resolve) => {
      const requestId = randomUUID();
      const expiresAt = Date.now() + AgentClient.APPROVAL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.resolveApproval(requestId, 'deny', 'No answer from your phone in 3 minutes — denied. Send the message again when you are ready.');
      }, AgentClient.APPROVAL_TIMEOUT_MS);
      this.pendingApprovals.set(requestId, { resolve, timer });

      this.send({
        type: 'permission_request',
        payload: { chatId, requestId, toolName, input, expiresAt },
        timestamp: Date.now(),
        messageId: this.generateId(),
      });
      console.log(`[Supervised] Asking phone: ${toolName} (${requestId.slice(0, 8)})`);
    });
  }

  /** Answer a pending approval (phone decision, timeout, or cancel). */
  private resolveApproval(requestId: string, behavior: 'allow' | 'deny', message?: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return; // already resolved / expired — idempotent
    this.pendingApprovals.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve({ behavior, message });
    console.log(`[Supervised] ${behavior}${message ? ` (${message})` : ''} for ${requestId.slice(0, 8)}`);
  }

  // ── Self-configuration (the vkconfig MCP tools) ────────────────────

  /** Human-readable current settings, for get_config and for confirmations. */
  private describeConfig(): string {
    const model = this.config.getModel();
    const tools = this.config.getAllowedTools();
    if (this.engine === 'codex') {
      return [
        'Engine: Codex',
        `Model: ${model || 'Codex default'}`,
        `Tool access: ${codexAccessFor(tools, false) === 'full' ? 'full (edits and commands allowed)' : 'read-only (no edits, no commands)'}`,
        `Working directory: ${this.workingDirectory}`,
        `Supervised mode: ${this.currentSupervised ? 'on' : 'off'}`,
      ].join('\n');
    }
    return [
      `Model: ${model || 'default (whatever your claude install picks)'}`,
      `Allowed tools: ${tools.length === 0 ? 'all (no restrictions)' : tools.join(', ')}`,
      `Working directory: ${this.workingDirectory}`,
      `Supervised mode: ${this.currentSupervised ? 'on' : 'off'}`,
    ].join('\n');
  }

  /**
   * POST /config from the vkconfig MCP child: the agent changing its own
   * settings because the conversation asked it to.
   *
   * Atomic. A call carrying both a safe change and a refused one applies
   * NEITHER, because partially-applied settings are the kind of thing a user
   * discovers three days later.
   */
  private async handleConfigToolCall(body: any): Promise<{ ok: boolean; text: string }> {
    if (body?.action === 'get') return { ok: true, text: this.describeConfig() };
    if (body?.action !== 'set') return { ok: false, text: 'Unsupported settings action.' };

    const raw: Record<string, unknown> = (body?.changes && typeof body.changes === 'object') ? body.changes : {};

    // Refuse unknown keys BY NAME instead of dropping them. The MCP schema
    // does not offer `token` or `wsUrl`, but a schema is a hint to the model,
    // not a gate — this is the gate. Writing `wsUrl` would re-point the agent
    // at someone else's server and hand over the machine, so it has to be
    // visibly impossible rather than quietly ignored, which would read back
    // to the model (and then the user) as "done".
    const unknown = Object.keys(raw).filter((k) => !(CONFIG_CHANGE_KEYS as readonly string[]).includes(k));
    if (unknown.length > 0) {
      return {
        ok: false,
        text: `Refused: ${unknown.join(', ')} cannot be changed from a conversation. `
          + 'The pairing itself (auth token and server URL) is deliberately not settable this way. '
          + `Changeable settings are: ${CONFIG_CHANGE_KEYS.join(', ')}.`,
      };
    }

    const next: ConfigChange = {};
    if ('model' in raw) {
      const m = raw.model;
      if (m !== null && typeof m !== 'string') return { ok: false, text: 'model must be a string, or null to clear it.' };
      if (typeof m === 'string' && !isValidModel(m, this.engine)) {
        return {
          ok: false,
          text: this.engine === 'codex'
            ? `"${m}" is not a Codex model name.`
            : `"${m}" is not a model name claude accepts. Use opus, sonnet, haiku, or a full claude model id.`,
        };
      }
      const codexModels = this.engine === 'codex' ? (this.codex?.models ?? []) : [];
      if (typeof m === 'string' && codexModels.length > 0 && !codexModels.includes(m.trim())) {
        return { ok: false, text: `"${m}" is not a model this Codex offers. Available: ${codexModels.join(', ')}.` };
      }
      next.model = m as string | null;
    }
    if ('allowedTools' in raw) {
      const t = raw.allowedTools;
      if (!Array.isArray(t) || t.some((x) => typeof x !== 'string' || !x.trim())) {
        return { ok: false, text: 'allowedTools must be an array of tool names.' };
      }
      next.allowedTools = (t as string[]).map((x) => x.trim());
      // Codex cannot honor a list allowing edits but not commands (or the
      // reverse). Refuse it by name rather than store a setting not in force.
      const problem = this.engine === 'codex' ? codexToolListProblem(next.allowedTools) : null;
      if (problem) return { ok: false, text: `${problem} Nothing changed.` };
    }
    if ('cwd' in raw) {
      if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) return { ok: false, text: 'cwd must be a path.' };
      next.cwd = raw.cwd.trim();
    }
    if ('supervised' in raw) {
      if (typeof raw.supervised !== 'boolean') return { ok: false, text: 'supervised must be true or false.' };
      next.supervised = raw.supervised;
    }
    if (Object.keys(next).length === 0) return { ok: false, text: 'No settings were named, so nothing changed.' };

    // Anything that reduces safety costs a tap on the phone, even when
    // supervised mode is off. The agent reads repos, issue text and web
    // pages, so the realistic attack is a poisoned file telling it to disarm
    // the user's own gate. Failure to reach the phone is a REFUSAL.
    const loosenings = describeLoosenings(
      { allowedTools: this.config.getAllowedTools(), supervised: this.currentSupervised },
      next,
    );
    if (loosenings.length > 0) {
      const summary = loosenings.join(' and ');
      // PHRASING IS CONSTRAINED BY THE SHIPPED CLIENT, not by taste. The card
      // renders `"Agent wants to run \(toolName)"` (NativeRemoteView) and the
      // push falls through to `"Wants to run \(toolName)"` (permissionSummary
      // in remote-agent.ts) whenever the input carries no command/file_path/
      // path/url key, which ours never will. Both of those templates are in
      // App Store builds that are already on phones and cannot be changed, so
      // the toolName has to complete those sentences by itself. A bare label
      // here renders as "Agent wants to run VibeKit settings", which is the
      // last thing the one card that guards against prompt injection should
      // look like. Keep this a phrase that reads after "wants to run".
      const decision = await this.askPhone(`a settings change: ${summary}`, {
        note: 'This reduces what the agent has to ask you about before it acts. Approve only if you just asked for this.',
      });
      if (decision.behavior !== 'allow') {
        return { ok: false, text: `Refused: ${summary} was not approved on the phone${decision.message ? ` (${decision.message})` : ''}. Nothing changed.` };
      }
    }

    // ORDER IS LOAD-BEARING for the atomicity promised above. Every field was
    // validated and the approval gate cleared before we got here, so the only
    // thing left that can fail is a directory that does not exist — which is
    // why cwd goes FIRST and can honestly report "nothing else changed".
    // setModel cannot throw after isValidModel, and setAllowedTools swallows
    // its own write errors. Reorder this and the guarantee quietly weakens.
    const applied: string[] = [];
    if (next.cwd !== undefined) {
      // Reuse the cd path so the directory is validated once and the server
      // gets its cd_result exactly as it does for a server-initiated cd.
      const result = this.changeDirectory(next.cwd);
      if (!result.success) return { ok: false, text: `Could not switch directory: ${result.error}. Nothing else changed.` };
      applied.push(`working directory is now ${result.path}`);
    }
    if (next.model !== undefined) {
      try { this.config.setModel(next.model); } catch (e: any) { return { ok: false, text: e?.message || 'Could not set the model.' }; }
      applied.push(next.model === null ? 'model override cleared' : `model is now ${next.model}`);
    }
    if (next.allowedTools !== undefined) {
      this.config.setAllowedTools(next.allowedTools);
      applied.push(next.allowedTools.length === 0
        ? 'tool restrictions removed'
        : `tools restricted to ${next.allowedTools.join(', ')}`);
    }
    if (next.supervised !== undefined) {
      applied.push(`supervised mode ${next.supervised ? 'on' : 'off'}`);
    }
    if (this.engine === 'codex'
      && (next.model !== undefined || next.allowedTools !== undefined || next.supervised !== undefined)) {
      // These are thread-scoped in Codex. Retire the old subscription now,
      // even if the user never sends the "next message" mentioned below.
      this.codex?.resetThread();
    }

    // Tell the server, so the phone shows the same thing and `supervised`
    // (which is server-owned, on the remote_agents row) actually persists.
    this.sendConfigState(next.supervised);

    return {
      ok: true,
      text: `Done: ${applied.join('; ')}. This takes effect on your NEXT message, not this one.`,
    };
  }

  /**
   * Report settings upward. `supervised` is included ONLY when the user just
   * asked to change it: the flag is owned by the server (it rides down on
   * each UserMessage), and echoing our stale copy back on every change would
   * let a config edit clobber a toggle made from the iOS sheet in between.
   */
  private sendConfigState(supervised?: boolean): void {
    this.send({
      type: 'config_state',
      payload: {
        model: this.config.getModel() || null,
        allowedTools: this.reportedAllowedTools(),
        workingDirectory: this.workingDirectory,
        ...(supervised === undefined ? {} : { supervised }),
      },
      timestamp: Date.now(),
      messageId: this.generateId(),
    });
  }

  /** Deny everything in flight — cancel, new message, or shutdown. */
  private denyAllPendingApprovals(reason: string): void {
    for (const id of [...this.pendingApprovals.keys()]) {
      this.resolveApproval(id, 'deny', reason);
    }
  }

  private handleCancel(): void {
    const run = this.activeRun;
    if (!run) {
      console.log('[Agent] Cancel received — no run in flight (no-op)');
      this.sendStatus('idle');
      return;
    }
    console.log(`[Agent] Cancel received, stopping the current ${run.engine} run`);
    this.denyAllPendingApprovals('Task was stopped from the app.');
    this.canceledRuns.add(run);
    this.cancelHeartbeats();
    this.stopStreaming();
    // Kill the pending debounced frame so no streaming text lands after the
    // "⏹ Stopped." message below.
    this.clearStreamingFlush();
    run.stop();
    if (this.currentChatId) {
      this.sendResponse(this.currentChatId, '⏹ Stopped.', 'complete');
    }
    // The run was killed mid-conversation; the session id (if captured) still
    // resumes past completed turns, so leave conversation state intact.
    this.sendStatus('idle');
  }

  /**
   * Handle write .env file command
   */
  private handleWriteEnv(envVars: { key: string; value: string }[]): void {
    try {
      const envPath = path.join(this.workingDirectory, '.env');

      // Build .env file content
      const envContent = envVars.map(({ key, value }) => {
        // Escape single quotes and backslashes
        const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        // Quote if contains spaces, newlines, or special chars
        const needsQuotes = /[\s#\n\r]/.test(value);
        return needsQuotes ? `${key}='${escaped}'` : `${key}=${value}`;
      }).join('\n');

      // Write .env file
      fs.writeFileSync(envPath, envContent + '\n', { mode: 0o600 });
      console.log(`[Agent] Created .env file with ${envVars.length} variables at ${envPath}`);
    } catch (error) {
      console.error('[Agent] Failed to write .env file:', error);
    }
  }

  /**
   * Handle change directory command.
   *
   * Thin wrapper: `changeDirectory` does the work and owns the cd_result
   * frame, so the self-config tool gets the same validation and the same
   * server-side bookkeeping without a second implementation.
   */
  private handleCdCommand(newPath: string): void {
    this.changeDirectory(newPath);
  }

  /** Resolve, validate, apply and announce a working-directory change. */
  private changeDirectory(newPath: string): { success: boolean; path?: string; error?: string } {
    const resolved = path.resolve(this.workingDirectory, newPath);

    try {
      const fs = require('fs');
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        this.send({
          type: 'cd_result',
          payload: { success: false, error: 'Directory not found' },
          timestamp: Date.now(),
          messageId: this.generateId(),
        });
        return { success: false, error: 'Directory not found' };
      }

      this.workingDirectory = resolved;
      this.config.setLastDirectory(resolved);
      // A Codex thread owns its cwd and per-thread read server. Release it
      // immediately instead of retaining both until another message arrives.
      this.codex?.resetThread();

      this.send({
        type: 'cd_result',
        payload: { success: true, path: resolved },
        timestamp: Date.now(),
        messageId: this.generateId(),
      });

      console.log(`Changed directory to: ${resolved}`);
      return { success: true, path: resolved };
    } catch (error) {
      this.send({
        type: 'cd_result',
        payload: { success: false, error: 'Failed to change directory' },
        timestamp: Date.now(),
        messageId: this.generateId(),
      });
      return { success: false, error: 'Failed to change directory' };
    }
  }

  /**
   * Send streaming update to Telegram
   */
  private sendStreaming(chatId: number, text: string): void {
    this.send({
      type: 'streaming',
      payload: {
        chatId,
        messageId: this.currentMessageId,
        text,
        workingDirectory: this.workingDirectory,
      },
      timestamp: Date.now(),
      messageId: this.generateId(),
    });
  }

  /**
   * Debounced flush of `streamJsonResult` over the WS as a `streaming`
   * message. Coalesces a burst of small Claude text deltas into a single
   * frame per ~80ms so the iOS UI re-renders smoothly without a flood of
   * WS messages. No-op if the cumulative text hasn't grown since last
   * flush — protects against firing on tool-result-only assistant events.
   */
  /**
   * Cancel a pending debounced streaming frame. Called on every terminal
   * path (complete/cancel/timeout/supersede) — without this, a delta that
   * arrived <80ms before run end fired its flush AFTER the complete
   * message, repainting the closed streaming bubble with stale text.
   */
  private clearStreamingFlush(): void {
    if (this.streamingFlushTimer) {
      clearTimeout(this.streamingFlushTimer);
      this.streamingFlushTimer = null;
    }
  }

  private scheduleStreamingFlush(): void {
    if (this.streamingFlushTimer) return;
    this.streamingFlushTimer = setTimeout(() => {
      this.streamingFlushTimer = null;
      if (!this.currentChatId) return;
      const text = this.streamJsonResult;
      if (text.length === this.lastStreamedLength) return;
      this.lastStreamedLength = text.length;
      // Trim trailing whitespace so iOS doesn't render a stray newline
      // mid-stream. Final text is sent verbatim via `done`.
      this.sendStreaming(this.currentChatId, text.replace(/\s+$/, ''));
    }, AgentClient.STREAM_FLUSH_DEBOUNCE_MS);
  }

  /**
   * Send a response back to Telegram
   */
  private sendResponse(chatId: number, text: string, status: 'streaming' | 'complete'): void {
    if (!this.currentTelegramId) {
      console.error('Cannot send response: the message had no owner id');
      return;
    }

    this.send({
      type: 'response',
      payload: {
        telegramId: this.currentTelegramId,
        chatId,
        text,
        status,
        replyToMessageId: this.currentReplyToMessageId || undefined,
      },
      timestamp: Date.now(),
      messageId: this.generateId(),
    });

    if (status === 'complete') {
      this.sendStatus('idle');
    }
  }

  /**
   * Send status update
   */
  private sendStatus(status: 'idle' | 'busy'): void {
    this.send({
      type: 'status',
      payload: { 
        status, 
        workingDirectory: this.workingDirectory,
        currentTask: status === 'busy' ? 'Thinking...' : undefined,
      },
      timestamp: Date.now(),
      messageId: this.generateId(),
    });
  }

  /**
   * Send a message to the WebSocket
   */
  private send(message: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    // Disconnected — queue so we can replay on reconnect. Without this, any
    // response/streaming/status frame produced during a brief WS drop (Mac
    // wake from sleep, WiFi flap) was silently lost and iOS never saw the
    // tail of a turn. Heartbeat pings are intentionally NOT queued — they're
    // pure liveness signals and stale ones would just confuse the server.
    if (message.type === 'pong' || message.type === 'auth') return;
    this.outboundQueue.push(message);
    while (this.outboundQueue.length > AgentClient.MAX_OUTBOUND_QUEUE) {
      this.outboundQueue.shift();
    }
  }

  /**
   * Replay queued outbound messages after WS reconnect.
   * Called from ws.on('open') after auth completes.
   */
  private flushOutboundQueue(): void {
    if (!this.outboundQueue.length || this.ws?.readyState !== WebSocket.OPEN) return;
    const queued = this.outboundQueue;
    this.outboundQueue = [];
    console.log(`[Agent] Flushing ${queued.length} queued message(s) after reconnect`);
    for (const msg of queued) {
      try { this.ws!.send(JSON.stringify(msg)); } catch {}
    }
  }

  /**
   * Schedule reconnection
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    // Floor the delay to 10s if the last attempt failed with a DNS error.
    // macOS's resolver typically takes 60-90s to recover after a network
    // change, so retrying at 1s/2s/4s is just wasted attempts.
    if (this.lastErrorWasDns && this.reconnectDelay < AgentClient.DNS_FAILURE_MIN_DELAY_MS) {
      this.reconnectDelay = AgentClient.DNS_FAILURE_MIN_DELAY_MS;
    }
    this.lastErrorWasDns = false;

    console.log(`Reconnecting in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  /**
   * Generate a unique message ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * macOS-only: spawn `caffeinate -i` so the system won't idle-sleep
   * while the agent is running. `-w <pid>` ties caffeinate's lifetime to
   * the agent process, so it dies automatically if we crash without
   * shutdown(). No-op on Linux/Windows (no `caffeinate` binary).
   */
  private startCaffeinate(): void {
    if (process.platform !== 'darwin') return;
    try {
      this.caffeinateProcess = spawn('caffeinate', ['-i', '-w', String(process.pid)], {
        stdio: 'ignore',
        detached: false,
      });
      this.caffeinateProcess.on('error', () => {
        // `caffeinate` is part of macOS — missing only in unusual setups.
        // Silently swallow; the agent still works, just lets the laptop sleep.
        this.caffeinateProcess = null;
      });
      console.log('[Caffeinate] Holding off idle sleep while agent is running');
    } catch {
      this.caffeinateProcess = null;
    }
  }

  /**
   * Shutdown the agent
   */
  private shutdown(): void {
    this.denyAllPendingApprovals('Agent is shutting down.');
    console.log('\nShutting down...');

    this.stopStreaming();

    if (this.activeRun) {
      this.activeRun.stop();
    }
    // app-server outlives each turn, so it is ended here even when idle.
    this.codex?.dispose();

    if (this.caffeinateProcess) {
      this.caffeinateProcess.kill();
    }

    if (this.ws) {
      this.ws.close();
    }

    process.exit(0);
  }

  /**
   * Set up Claude credentials for auto mode
   * In auto mode, credentials come from:
   * 1. CLAUDE_CODE_OAUTH_TOKEN env var (preferred - set by entrypoint.sh)
   * 2. CLAUDE_OAUTH_JSON env var (base64 encoded)
   * 3. --credentials-file argument
   */
  private async setupAutoModeCredentials(): Promise<void> {
    // If CLAUDE_CODE_OAUTH_TOKEN is already set, Claude Code will use it directly
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      console.log('[AutoMode] CLAUDE_CODE_OAUTH_TOKEN already set, skipping credential setup');
      return;
    }

    const credentialsFile = this.config.getCredentialsFile();
    const oauthJson = process.env.CLAUDE_OAUTH_JSON;

    // Determine where to get credentials from
    let credentialsData: string | null = null;

    if (credentialsFile && fs.existsSync(credentialsFile)) {
      // Read from file
      console.log(`[AutoMode] Loading credentials from ${credentialsFile}`);
      credentialsData = fs.readFileSync(credentialsFile, 'utf-8');
    } else if (oauthJson) {
      // Decode from environment variable (base64)
      console.log('[AutoMode] Loading credentials from CLAUDE_OAUTH_JSON env var');
      credentialsData = Buffer.from(oauthJson, 'base64').toString('utf-8');
    }

    if (!credentialsData) {
      console.error('[AutoMode] No credentials found. Set CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_OAUTH_JSON, or --credentials-file');
      process.exit(1);
    }

    // Try to extract OAuth token and set it as environment variable
    try {
      const creds = JSON.parse(credentialsData);
      const accessToken = creds.claudeAiOauth?.accessToken;
      if (accessToken) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = accessToken;
        console.log('[AutoMode] Extracted and set CLAUDE_CODE_OAUTH_TOKEN');
      }
    } catch (e) {
      console.error('[AutoMode] Failed to parse credentials JSON:', e);
    }

    // Write credentials to Claude's expected location as backup
    const homeDir = process.env.HOME || '/home/agent';
    const claudeDir = path.join(homeDir, '.claude');

    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // Write credentials (use .credentials.json which is Claude's expected name)
    const credentialsPath = path.join(claudeDir, '.credentials.json');
    fs.writeFileSync(credentialsPath, credentialsData, { mode: 0o600 });

    // Also write settings to indicate onboarding is complete
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      const settings = {
        hasCompletedOnboarding: true,
        acceptedTerms: true,
        permissions: { defaultMode: 'acceptEdits' }
      };
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    }

    console.log('[AutoMode] Claude credentials configured');
  }

  /**
   * Sign the local `claude` in using the user's OWN Claude creds from their
   * VibeKit account, so they don't have to run a separate `claude setup-token`.
   * No-op if the box already has an explicit Claude env credential (we respect a
   * local sign-in) or if the account has none. Env-only — we never overwrite the
   * user's global ~/.claude; the token is scoped to the claude WE spawn.
   */
  private async ensureAccountClaudeAuth(): Promise<void> {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return;

    const creds = await this.fetchServerClaudeCredentials();
    if (!creds) return; // not reachable / network — local claude may be authed
    if (!creds.hasCredentials) {
      if (creds.expired) {
        console.log("Your VibeKit account's Claude sign-in needs reconnecting. In the app open Profile > Bring your own > Claude. Falling back to this machine's local `claude`.\n");
      }
      return;
    }
    this.applyClaudeCredentials(creds);
    const label = creds.type === 'oauth'
      ? (creds.subscriptionType ? `Claude ${creds.subscriptionType}` : 'Claude subscription')
      : 'Claude API key';
    console.log(`Signed in to Claude from your VibeKit account (${label}).\n`);
  }

  /** Apply fetched account creds to env (scoped to the claude we spawn). */
  private applyClaudeCredentials(creds: ServerClaudeCreds): void {
    if (creds.type === 'oauth' && creds.oauthToken) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = creds.oauthToken;
    } else if (creds.type === 'api_key' && creds.apiKey) {
      process.env.ANTHROPIC_API_KEY = creds.apiKey;
    }
  }

  /**
   * GET the user's Claude creds from the server, authenticated by the agent's
   * own token. HTTPS-only; short timeout; never throws (returns null on any
   * failure so the caller falls back to local auth).
   */
  private async fetchServerClaudeCredentials(): Promise<ServerClaudeCreds | null> {
    const serverUrl = process.env.VIBEKIT_SERVER || 'https://vibekit.bot';
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(serverUrl);
    if (!serverUrl.startsWith('https://') && !isLocal) return null; // never send creds over plain http
    const token = this.config.getToken();
    if (!token) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(`${serverUrl}/api/agent/claude-credentials`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!resp.ok) return null;
      return (await resp.json()) as ServerClaudeCreds;
    } catch {
      return null;
    }
  }

  /** Whether the last claude run's stderr looks like an auth failure. */
  private looksLikeClaudeAuthFailure(): boolean {
    // Auth failures surface on stderr OR as an is_error `result` string
    // (e.g. "Invalid API key · Please run /login"), so check both.
    const haystack = `${this.lastRunStderr}\n${this.lastRunResultError}`;
    return /invalid (api|x-api)[- ]?key|authentication_error|not (logged in|authenticated)|unauthenticated|please run .*\/?login|setup-token|oauth[^\n]*expired|\b401\b|\b403\b/i.test(haystack);
  }

  /**
   * A claude run failed on auth. Try to re-sync the account creds (the user may
   * have just (re)connected Claude in the app), then tell them how to fix it.
   */
  private async handleClaudeAuthFailure(chatId: number): Promise<void> {
    let resynced = false;
    const creds = await this.fetchServerClaudeCredentials();
    if (creds?.hasCredentials) {
      this.applyClaudeCredentials(creds);
      resynced = true;
    }
    // The un-resynced message leads with the in-app fix on purpose. Whoever
    // reads this is driving the agent REMOTELY, so the shell command is the
    // one instruction they may be unable to follow; signing in from the app
    // writes the credential to their account and this handler picks it up on
    // the next message with no shell access at all.
    const msg = resynced
      ? "Re-synced your Claude sign-in from your VibeKit account. Please resend your last message."
      : "Claude isn't signed in for this agent. In the VibeKit app open Profile > Bring your own > Claude and sign in, then resend. No terminal needed. (On the machine itself, `claude setup-token` also works.)";
    this.sendResponse(chatId, msg, 'complete');
  }
}
