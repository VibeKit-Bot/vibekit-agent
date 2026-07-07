import WebSocket from 'ws';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dns from 'dns';
import { Config } from './config';

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
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

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

interface UserMessage {
  type: 'message';
  payload: {
    telegramId: number;
    chatId: number;
    text: string;
    messageId: number;
    attachments?: MessageAttachment[];
  };
}

export class AgentClient {
  private config: Config;
  private ws: WebSocket | null = null;
  private claudeProcess: ChildProcess | null = null;
  private caffeinateProcess: ChildProcess | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private isConnected = false;
  private currentChatId: number | null = null;
  private currentTelegramId: number | null = null;
  private currentReplyToMessageId: number | null = null;
  private outputBuffer = '';
  private streamingInterval: NodeJS.Timeout | null = null;
  private lastFlushedLength = 0;
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

  // Hard kill timer for a wedged Claude run. Mirrors the server's 5-min SSE
  // ceiling at src/routes/remote-app.ts so client + server agree on "this
  // run is dead". Without this the agent's claudeProcess can sit forever on
  // an infinite bash loop / stuck API call, blocking every subsequent
  // message and leaving the user staring at a spinner.
  private claudeRunTimeout: NodeJS.Timeout | null = null;
  private static readonly CLAUDE_RUN_TIMEOUT_MS = 5 * 60_000;

  // Set when handleUserMessage acknowledged the cancellation of a previous
  // in-flight run before overwriting currentChatId. Stops the killed run's
  // 'close' handler from sending a "no response" fallback to the NEW chatId
  // (currentChatId has already moved on to the new message). Without this
  // flag, the new message's chat would receive a confusing "Agent exited
  // without a response (code -15)" before its real reply.
  private claudeWasCanceled = false;

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
  async link(): Promise<void> {
    console.log('Connecting to VibeKit...\n');

    // Request a link from the server
    const serverUrl = process.env.VIBEKIT_SERVER || 'https://vibekit.bot';

    try {
      // Generate a temporary link code request
      console.log('To link your computer:');
      console.log('');
      console.log('iPhone: Open the VibeKit app, go to "Remote", and tap "Generate Link Code"');
      console.log('Telegram: Open @the_vibe_kit_bot and send /remote');
      console.log('Then copy the 6-character code and paste it here.');
      console.log('');

      // Wait for user to enter the code. Loop on local validation errors
      // (wrong length, mistype) and on server-rejected codes so the user
      // doesn't have to re-run the whole command after a typo.
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const askCode = (): Promise<string> => new Promise((resolve) => {
        rl.question('Enter the code from iOS or Telegram: ', (answer) => {
          resolve(answer.trim().toUpperCase());
        });
      });

      let result: { token: string; wsUrl: string } | null = null;
      while (!result) {
        const code = await askCode();
        if (!code) {
          console.log('Empty input — try again or press Ctrl+C to cancel.');
          continue;
        }
        if (code.length !== 6) {
          console.log(`Code is 6 characters (got ${code.length}). Try again or press Ctrl+C to cancel.`);
          continue;
        }

        console.log('\nValidating code...');
        let response: Response;
        try {
          response = await fetch(`${serverUrl}/api/agent/link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
          });
        } catch (e: any) {
          console.log(`Network error: ${e?.message || e}. Try again or press Ctrl+C to cancel.\n`);
          continue;
        }

        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({ error: 'Unknown error' }))) as { error?: string };
          console.log(`${errorData.error || 'Invalid or expired code'}. Generate a fresh code in iOS / Telegram and try again, or press Ctrl+C to cancel.\n`);
          continue;
        }

        result = (await response.json()) as { token: string; wsUrl: string };
      }
      rl.close();

      this.config.setCredentials(result.token, result.wsUrl);

      console.log('\nLinked successfully!');
      console.log('');
      console.log('Tip: connect Claude in the VibeKit app (Profile → Connect Claude)');
      console.log('and the agent signs Claude in automatically — no setup-token needed.');
      console.log('');
      console.log('Start the agent with:');
      console.log('  npx vibekit-agent start');
      console.log('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Link failed:', message);
      process.exit(1);
    }
  }

  /**
   * Start the agent and connect to VibeKit
   */
  async start(directory: string, autoMode: boolean = false): Promise<void> {
    this.workingDirectory = path.resolve(directory);

    // Don't persist directory in auto mode (ephemeral container)
    if (!autoMode) {
      this.config.setLastDirectory(this.workingDirectory);
    }

    console.log(`Starting VibeKit Remote Agent...`);
    console.log(`Working directory: ${this.workingDirectory}`);

    // In auto mode, set up Claude credentials from the credentials file.
    // Otherwise, sign Claude in from the user's VibeKit account if they've
    // connected it there — so they don't need a separate `claude setup-token`.
    if (autoMode) {
      await this.setupAutoModeCredentials();
    } else {
      await this.ensureAccountClaudeAuth();
    }

    // Check for claude binary at startup
    const claudePath = findClaudeBinary();
    if (claudePath) {
      console.log(`Claude Code found: ${claudePath}`);
    } else {
      console.log('\nClaude Code not found locally — will auto-run via `npx @anthropic-ai/claude-code` on first message.');
      console.log('(First invocation downloads ~50MB and takes ~30s; cached thereafter.)');
      console.log('For a faster first message, install ahead of time: `claude install` or `npm install -g @anthropic-ai/claude-code`.\n');
    }
    console.log('');

    // Prevent the laptop from idle-sleeping while the agent is running.
    // Without this, the macOS process gets suspended on sleep, the
    // WebSocket times out server-side, and the iOS Remote tab shows
    // "agent offline" until the laptop wakes. Lid-close sleep is still
    // unstoppable from userspace — this only blocks idle sleep.
    this.startCaffeinate();

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

    // Kill any existing process. If one is in flight, handleUserMessage already
    // sent a "canceled" reply to its chatId — the suppression flag below stops
    // the close handler from re-sending a misattributed fallback to the new
    // chat.
    if (this.claudeProcess) {
      this.claudeWasCanceled = true;
      this.claudeProcess.kill();
    }

    // Clear streaming state
    this.stopStreaming();
    this.outputBuffer = '';
    this.lastFlushedLength = 0;
    this.currentMessageId = null;

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

    if (allowedTools.length === 0) {
      // No restrictions - allow everything
      args.push('--dangerously-skip-permissions');
    } else {
      // Use specific allowed tools
      args.push('--allowedTools', allowedTools.join(','));
    }

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

    this.claudeProcess = spawn(command, spawnArgs, {
      cwd: this.workingDirectory,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Hard 5-min kill timer. Mirrors the server's SSE inactivity ceiling so
    // a wedged Claude (infinite bash loop, stuck API call, --continue session
    // corruption) doesn't block every subsequent message indefinitely. Power
    // users on multi-hour bash can disable with VIBEKIT_AGENT_NO_TIMEOUT=1.
    if (this.claudeRunTimeout) clearTimeout(this.claudeRunTimeout);
    if (!process.env.VIBEKIT_AGENT_NO_TIMEOUT) {
      const proc = this.claudeProcess;
      const chatIdAtStart = this.currentChatId;
      this.claudeRunTimeout = setTimeout(() => {
        // Only act if THIS process is still the current one — a new message
        // may have replaced it, in which case the cancellation handler runs.
        if (this.claudeProcess !== proc) return;
        console.log(`[Agent] Claude run exceeded ${AgentClient.CLAUDE_RUN_TIMEOUT_MS / 1000}s — killing`);
        if (chatIdAtStart) {
          this.sendResponse(
            chatIdAtStart,
            "_Run exceeded 5 minutes and was stopped. Try a smaller task or split it up._",
            'complete'
          );
        }
        // Mark canceled so the close handler doesn't double-send.
        this.claudeWasCanceled = true;
        try { proc.kill('SIGKILL'); } catch {}
      }, AgentClient.CLAUDE_RUN_TIMEOUT_MS);
    }

    // Track the final result text from stream-json
    this.streamJsonResult = '';
    this.lastRunResultError = '';
    this.lastRunStderr = '';
    this.receivedPartialDeltas = false;
    this.streamJsonLineBuffer = '';
    this.lastStreamedLength = 0;
    this.activeToolCalls.clear();
    this.toolUseCountThisRun = 0;
    // Heartbeat statuses fire if Claude is slow to produce anything visible.
    // Real activity (tool/delta) cancels them in their handlers below.
    this.scheduleHeartbeats();

    this.claudeProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
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

    this.claudeProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      process.stderr.write(text);
      // Keep the tail so the close handler can classify auth failures.
      this.lastRunStderr = (this.lastRunStderr + text).slice(-8192);
    });

    this.claudeProcess.on('close', (code) => {
      console.log(`\nClaude exited with code ${code}`);

      // Always clear the run-timeout timer so it doesn't leak past process exit.
      if (this.claudeRunTimeout) {
        clearTimeout(this.claudeRunTimeout);
        this.claudeRunTimeout = null;
      }
      // Run finished — kill any pending heartbeats so they don't fire post-exit.
      this.cancelHeartbeats();

      // If this run was killed because a new message arrived, the cancellation
      // was already acknowledged in handleUserMessage to the OLD chatId.
      // Don't re-emit an "exited without response" to the NEW chatId — that
      // would prepend a confusing failure to the new message's reply.
      if (this.claudeWasCanceled) {
        this.claudeWasCanceled = false;
        this.claudeProcess = null;
        return;
      }

      // Process any remaining buffered line
      if (this.streamJsonLineBuffer.trim()) {
        this.processStreamJsonLine(this.streamJsonLineBuffer.trim());
      }

      this.stopStreaming();

      // Send final result
      if (this.currentChatId && this.currentTelegramId) {
        let finalText = this.streamJsonResult.trim();
        // When Claude errors, the SAME raw error string arrives twice: as the
        // is_error `result` (stashed in lastRunResultError, never forwarded)
        // AND as a plain assistant text block, which flows into
        // streamJsonResult via the streaming path. If the "reply" is just that
        // echoed error (e.g. "Invalid API key · Please run /login"), blank it
        // so the classifier below translates it instead of forwarding it raw.
        if (finalText && this.lastRunResultError && finalText === this.lastRunResultError.trim()) {
          finalText = '';
        }
        if (finalText) {
          console.log(`[Agent] Sending final response (${finalText.length} chars)`);
          this.sendResponse(this.currentChatId, finalText, 'complete');
        } else {
          // Claude exited without producing text. Don't claim success — be honest
          // so the user doesn't think we completed something we didn't.
          const toolCount = this.toolUseCountThisRun;
          let fallback: string | null;
          if (this.looksLikeClaudeAuthFailure()) {
            // Don't bury an auth problem under a generic exit message — handle
            // it explicitly (and try to re-sync the account's Claude creds, in
            // case the user just connected Claude in the app). Suppress the
            // generic fallback so we don't double-send. Not gated on exit code:
            // an auth failure can arrive as an is_error result with code 0.
            void this.handleClaudeAuthFailure(this.currentChatId);
            fallback = null;
          } else if (this.lastRunResultError) {
            // Claude returned a non-auth error as its result — surface it
            // (trimmed) instead of a generic "no response".
            fallback = `Claude reported an error: ${this.lastRunResultError.trim().slice(0, 300)}`;
          } else if (code !== 0) {
            fallback = `Agent exited without a response (code ${code}). Please try again.`;
          } else if (toolCount > 0) {
            fallback = `Agent finished after ${toolCount} tool call${toolCount === 1 ? '' : 's'} but didn't write a reply. Expand the tool calls above to see what was done, or send another message to continue.`;
          } else {
            fallback = `Agent finished without producing a response. Try rephrasing or resending.`;
          }
          if (fallback) {
            console.log(`[Agent] No result text collected, sending honest fallback (code=${code}, tools=${toolCount})`);
            this.sendResponse(this.currentChatId, fallback, 'complete');
          }
        }
      }

      this.claudeProcess = null;

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

    this.claudeProcess.on('error', (err) => {
      console.error('Failed to start claude:', err.message);
      if (this.claudeRunTimeout) {
        clearTimeout(this.claudeRunTimeout);
        this.claudeRunTimeout = null;
      }
      this.cancelHeartbeats();
      this.stopStreaming();
      if (this.currentChatId && this.currentTelegramId) {
        this.sendResponse(
          this.currentChatId,
          `Error: Could not start Claude Code.\n\nPath: ${claudeBinary}\nError: ${err.message}`,
          'complete'
        );
      }
    });
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
              // Result might be the final text or a summary
              this.streamJsonResult = event.result;
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
   * Start streaming interval to send partial output
   */
  private startStreaming(): void {
    // Clear any existing interval
    this.stopStreaming();

    // Send updates every 2 seconds for more responsive feedback
    this.streamingInterval = setInterval(() => {
      this.flushPartialOutput();
    }, 2000);
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
   * Flush partial output if buffer has grown since last flush
   */
  private flushPartialOutput(): void {
    if (!this.currentChatId || !this.currentTelegramId) {
      return;
    }

    // Check if buffer has new content
    if (this.outputBuffer.length <= this.lastFlushedLength) {
      return;
    }

    // Update last flushed length
    this.lastFlushedLength = this.outputBuffer.length;

    // Clean the output
    let cleaned = stripAnsi(this.outputBuffer);

    // Parse for meaningful updates
    const display = this.extractStreamingStatus(cleaned);

    if (display.trim().length > 0) {
      this.sendStreaming(this.currentChatId, display.trim());
      // Mark that streaming has started (even if ack hasn't arrived yet)
      // This prevents duplicate final responses in flushOutput()
      if (this.currentMessageId === null) {
        this.currentMessageId = -1; // Temporary marker until we get the real ID from ack
      }
    }
  }

  // Track last sent status to avoid duplicate updates
  private lastSentStatus: string = '';

  /**
   * Extract meaningful status from Claude output for streaming display
   */
  private extractStreamingStatus(output: string): string {
    const lines = output.split('\n');
    const updates: string[] = [];

    // Look for tool calls and actions - scan more lines for better detection
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 100); i--) {
      const line = lines[i].trim();

      // Skip empty lines
      if (!line) continue;

      // Claude Code tool patterns (more comprehensive)
      if (line.includes('Read(') || line.match(/Reading\s+[`"']?[\w/.]+/i)) {
        const match = line.match(/(?:Read\(|Reading)\s*[`"']?([^`"'\s,)]+)/i);
        if (match) updates.push(`</> Reading ${this.truncatePath(match[1])}`);
      } else if (line.includes('Write(') || line.match(/Writing\s+[`"']?[\w/.]+/i)) {
        const match = line.match(/(?:Write\(|Writing)\s*[`"']?([^`"'\s,)]+)/i);
        if (match) updates.push(`[+] Writing ${this.truncatePath(match[1])}`);
      } else if (line.includes('Edit(') || line.match(/Editing\s+[`"']?[\w/.]+/i)) {
        const match = line.match(/(?:Edit\(|Editing)\s*[`"']?([^`"'\s,)]+)/i);
        if (match) updates.push(`[~] Editing ${this.truncatePath(match[1])}`);
      } else if (line.includes('Bash(') || line.match(/Running|Executing/i)) {
        const match = line.match(/(?:Bash\(|Running|Executing)[:\s]*[`"']?(.{1,50})/i);
        if (match) updates.push(`$__ ${match[1].replace(/[`"']/g, '').slice(0, 40)}...`);
      } else if (line.includes('Glob(') || line.match(/Searching\s+files/i)) {
        updates.push(`(*) Searching files...`);
      } else if (line.includes('Grep(') || line.match(/Searching\s+code/i)) {
        updates.push(`/?/ Searching code...`);
      } else if (line.includes('WebSearch') || line.match(/searching\s+(?:the\s+)?web/i)) {
        updates.push(`@-> Searching web...`);
      } else if (line.includes('WebFetch') || line.match(/fetching\s+(?:page|url)/i)) {
        updates.push(`<~> Fetching page...`);
      } else if (line.match(/npm\s+(?:install|i\b)/i) || line.includes('Installing')) {
        updates.push(`[*] Installing dependencies...`);
      } else if (line.match(/npm\s+(?:run\s+)?build/i) || line.includes('Building')) {
        updates.push(`[*] Building project...`);
      } else if (line.match(/npm\s+(?:run\s+)?test/i) || line.includes('Testing')) {
        updates.push(`[*] Running tests...`);
      } else if (line.match(/git\s+(?:add|commit|push)/i)) {
        const match = line.match(/git\s+(add|commit|push)/i);
        if (match) updates.push(`[*] Git ${match[1]}...`);
      } else if (line.match(/created?\s+(?:file|directory)/i)) {
        const match = line.match(/created?\s+(?:file|directory)\s*:?\s*[`"']?([^`"'\s]+)/i);
        if (match) updates.push(`[+] Created ${this.truncatePath(match[1])}`);
      }

      // Stop if we have enough updates
      if (updates.length >= 5) break;
    }

    // Deduplicate and take most recent unique actions
    const uniqueUpdates = [...new Set(updates)].slice(0, 4);

    // If we found specific actions, show those
    if (uniqueUpdates.length > 0) {
      const status = uniqueUpdates.reverse().join('\n');
      
      // Send status update to server if changed
      if (status !== this.lastSentStatus) {
        this.lastSentStatus = status;
        this.sendStatusUpdate(uniqueUpdates[uniqueUpdates.length - 1]);
      }
      
      return status;
    }

    // Otherwise show last few non-empty lines
    const recentLines = lines
      .slice(-10)
      .filter(l => l.trim().length > 0 && !l.match(/^\s*[\[\]{}]\s*$/)) // Skip JSON brackets
      .slice(-3);

    if (recentLines.length > 0) {
      let display = recentLines.join('\n');
      if (display.length > 300) {
        display = '...' + display.slice(-297);
      }
      
      // Send generic "Working..." status when we have output but no specific action
      const genericStatus = 'Working...';
      if (genericStatus !== this.lastSentStatus) {
        this.lastSentStatus = genericStatus;
        this.sendStatusUpdate(genericStatus);
      }
      
      return display;
    }

    return output.length > 300 ? '...\n' + output.slice(-297) : output;
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
    this.outputBuffer = '';
    this.lastFlushedLength = 0;
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
    let handshakeTimer: NodeJS.Timeout | null = setTimeout(() => {
      handshakeTimer = null;
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
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
      this.stopHeartbeatWatchdog();
      this.stopWakeWatchdog();
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      clearHandshakeTimer();
      console.error('WebSocket error:', error.message);
      this.isConnected = false;
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
        const payload = message.payload as { telegramId: number; agentName?: string } | undefined;
        const label = payload?.agentName?.trim();
        if (label) {
          console.log(`Authenticated as "${label}"`);
        } else {
          console.log('Authenticated successfully');
        }
        console.log('');
        console.log('Ready! Send messages from the VibeKit iOS app in "Remote" or via @the_vibe_kit_bot on Telegram.');
        console.log('Press Ctrl+C to stop.');
        console.log('');
        this.sendStatus('idle');
        // Replay anything we couldn't send while the WS was down — the tail
        // of a turn that finished mid-disconnect lands here on reconnect.
        this.flushOutboundQueue();
        break;
      }

      case 'auth_error':
        console.error('Authentication failed:', (message.payload as { message: string }).message);
        this.config.clear();
        process.exit(1);
        break;

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
   * Handle user message from Telegram or iOS app
   */
  private handleUserMessage(message: UserMessage): void {
    const { chatId, text, telegramId, messageId, attachments } = message.payload;

    // If a previous run is still in flight when a new message arrives, send
    // a "canceled" acknowledgment to ITS chatId before we overwrite
    // currentChatId. Pre-2026-05-09 this was a silent SIGTERM (in
    // runClaude) — the user's first message bubble + spinner just hung
    // forever with no signal. Now they see an explicit cancellation in
    // the original chat and the new message proceeds normally.
    if (this.claudeProcess && this.currentChatId && this.currentChatId !== chatId) {
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
    const attachmentInfo = attachments?.length ? ` with ${attachments.length} attachment(s)` : '';
    const source = chatId < 0 ? 'iOS' : 'Telegram';
    console.log(`\nReceived from ${source}: ${text || '(no text)'}${attachmentInfo}`);

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

    // Run claude with the prompt (stream-json will send status updates)
    this.runClaude(prompt);
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
    console.log('Conversation reset - next message will start fresh');
  }

  /**
   * Explicit Stop from the app. Kill the in-flight Claude run (if any),
   * acknowledge to the chat so the transcript shows the stop, and flip
   * status back to idle so tiles/status endpoints don't keep saying
   * "working". Mirrors the supersede-by-new-message path: claudeWasCanceled
   * suppresses the close handler's "exited without response" double-send.
   */
  private handleCancel(): void {
    if (!this.claudeProcess) {
      console.log('[Agent] Cancel received — no run in flight (no-op)');
      this.sendStatus('idle');
      return;
    }
    console.log('[Agent] Cancel received — stopping current Claude run');
    this.claudeWasCanceled = true;
    this.cancelHeartbeats();
    this.stopStreaming();
    try { this.claudeProcess.kill(); } catch { /* already gone */ }
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
   * Handle change directory command
   */
  private handleCdCommand(newPath: string): void {
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
        return;
      }

      this.workingDirectory = resolved;
      this.config.setLastDirectory(resolved);

      this.send({
        type: 'cd_result',
        payload: { success: true, path: resolved },
        timestamp: Date.now(),
        messageId: this.generateId(),
      });

      console.log(`Changed directory to: ${resolved}`);
    } catch (error) {
      this.send({
        type: 'cd_result',
        payload: { success: false, error: 'Failed to change directory' },
        timestamp: Date.now(),
        messageId: this.generateId(),
      });
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
      console.error('Cannot send response: no telegram ID');
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
    console.log('\nShutting down...');

    this.stopStreaming();

    if (this.claudeProcess) {
      this.claudeProcess.kill();
    }

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
        console.log("Your VibeKit account's Claude sign-in has expired — reconnect Claude in the app (Profile → Connect Claude). Falling back to this machine's local `claude`.\n");
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
    const msg = resynced
      ? "Re-synced your Claude sign-in from your VibeKit account. Please resend your last message."
      : "Claude isn't signed in on the agent machine. Connect Claude in your VibeKit account (Profile → Connect Claude), or run `claude setup-token` on that machine, then resend.";
    this.sendResponse(chatId, msg, 'complete');
  }
}
