/**
 * codex-engine.ts: drives OpenAI's Codex CLI through `codex app-server`
 * (newline-delimited JSON-RPC over stdio, no `jsonrpc` field) for Remote mode.
 * Design and the protocol facts it relies on: docs/remote-codex-plan.md.
 *
 * WHY app-server AND NOT `codex exec --json`: exec has no approval channel, so
 * "Ask before actions" could not exist. app-server sends approval requests to
 * the client and waits for the answer.
 *
 * One app-server child lives for the life of the agent process, started on the
 * first Codex message. Unlike a Claude run it outlives each turn, so it is
 * killed on every exit path, including the self-update restart that calls
 * process.exit directly.
 *
 * Only stable protocol methods are used: `initialize` declares no
 * experimentalApi. Every mapping from Codex events to VibeKit frames is in the
 * pure codex-translate.ts.
 */
import { spawn, execFileSync, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CodexAccess } from './config';
import { CodexOutput, CodexTurnEnd, CodexTurnTranslator, codexPolicy } from './codex-translate';

/** The newest Codex CLI this engine was checked against. Older versions still run, with a warning. */
export const CODEX_TESTED_VERSION = '0.154.0';

/** How long an interrupted turn gets to report `interrupted` before the app-server is killed. */
const INTERRUPT_GRACE_MS = 5_000;
/** Control requests (initialize, account/read, thread/start) that take longer than this count as a failed start. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Avoid a tight respawn loop when an installed app-server cannot initialize. */
const START_RETRY_BACKOFF_MS = 1_000;

/** The self-config MCP server's name. Its tool calls never need a phone tap, the same as on Claude. */
export const VKCONFIG_SERVER = 'vkconfig';

function searchPath(): string {
  const home = os.homedir();
  return [
    path.dirname(process.execPath), // the npm `codex` shim is a node script
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    process.env.PATH || '',
  ].join(':');
}

/** `codex --version` for one candidate, or null when it does not run (a broken install counts as absent). */
function codexVersion(binary: string): string | null {
  try {
    const out = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: searchPath() },
    });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Find a Codex CLI that actually runs. Existence is not enough: an npm install
 * that lost its platform binary still leaves a `codex` shim that fails with
 * ENOENT on every call, which would otherwise surface as a failure on every
 * message instead of a clear "not installed".
 */
export function findCodexBinary(log: (line: string) => void = console.log): { path: string; version: string } | null {
  const home = os.homedir();
  const candidates: string[] = [];
  if (process.env.CODEX_PATH) candidates.push(process.env.CODEX_PATH);
  try {
    const found = execFileSync('which', ['-a', 'codex'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: searchPath() },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    candidates.push(...found.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { /* not on PATH */ }
  try {
    const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (prefix) candidates.push(path.join(prefix, 'bin', 'codex'));
  } catch { /* no npm */ }
  candidates.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(home, '.npm-global', 'bin', 'codex'));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate) || !fs.existsSync(candidate)) continue;
    seen.add(candidate);
    const version = codexVersion(candidate);
    if (version) return { path: candidate, version };
    log(`Skipping ${candidate}: \`codex --version\` fails there, so that install looks broken.`);
  }
  return null;
}

/** Whether this Codex is logged in, from `codex login status` (exits 1 with "Not logged in"). Null when that cannot be told. */
export function codexLoggedIn(binary: string): boolean | null {
  try {
    execFileSync(binary, ['login', 'status'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: searchPath() } });
    return true;
  } catch (e: any) {
    return e?.status === 1 && /not logged in/i.test(`${e?.stdout || ''}${e?.stderr || ''}`) ? false : null;
  }
}

/** True when `version` is a lower release than `floor`. Unparseable counts as not older. */
export function isOlderVersion(version: string, floor: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const a = parse(version);
  const b = parse(floor);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Codex's per-server tool approval mode. Verified on 0.154.0: accepts auto, prompt, writes, approve. */
  approvalMode?: 'auto' | 'prompt' | 'writes' | 'approve';
}

export interface CodexTurnRequest {
  prompt: string;
  imagePaths: string[];
  cwd: string;
  model?: string;
  access: CodexAccess;
  /** Read when a thread starts or resumes, so it can include the model list fetched just before. */
  mcpServers: () => Record<string, McpServerSpec>;
}

export interface CodexTurnHooks {
  output(o: CodexOutput): void;
  /** Ask the phone. Resolves true for allow; timeouts and disconnects resolve false. */
  approve(toolName: string, input: Record<string, unknown>): Promise<boolean>;
}

export interface CodexTurnHandle {
  done: Promise<CodexTurnEnd>;
  stop(): void;
}

class CodexRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

interface Turn {
  translator: CodexTurnTranslator;
  hooks: CodexTurnHooks;
  /** The thread this turn runs on, fixed when it starts, so a New Conversation mid-turn cannot orphan it. */
  threadId: string | null;
  /** Conversation generation captured when the message arrived. */
  conversationGeneration: number;
  /** This thread was superseded while it was being created and retires after this turn. */
  retireThreadAfterFinish: boolean;
  id: string | null;
  stopRequested: boolean;
  finished: boolean;
  killTimer: NodeJS.Timeout | null;
  resolve: (end: CodexTurnEnd) => void;
}

/** mcp_servers.* dotted keys for thread/start's `config`. */
export function mcpConfig(servers: Record<string, McpServerSpec>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(servers)) {
    config[`mcp_servers.${name}.command`] = spec.command;
    config[`mcp_servers.${name}.args`] = spec.args;
    config[`mcp_servers.${name}.env`] = spec.env;
    if (spec.approvalMode) config[`mcp_servers.${name}.default_tools_approval_mode`] = spec.approvalMode;
  }
  return config;
}

export class CodexEngine {
  private static liveEngines = new Set<CodexEngine>();
  private static exitHookInstalled = false;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private ready = false;
  private nextStartAt = 0;
  private nextId = 1;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null }>();
  private stderrTail = '';
  private loggedIn = false;
  private threadId: string | null = null;
  private threadCwd: string | null = null;
  private threadAccess: CodexAccess | null = null;
  private conversationGeneration = 0;
  private retiredThreads = new Set<string>();
  /** The app-server restarted since the thread was created, so it must be resumed before its next turn. */
  private threadNeedsResume = false;
  /** The thread carries a model override. turn/start's `model` persists, so clearing it needs a new thread. */
  private threadHasModelOverride = false;
  private turn: Turn | null = null;
  private lastTurnDone: Promise<unknown> = Promise.resolve();
  /** Turns run one at a time, so only the last finished one can still send late events. */
  private lastFinishedTurnId: string | null = null;

  /** Model ids from model/list, for validating a model change from chat. Empty until the first turn. */
  models: string[] = [];
  /** When the plan's exhausted rate-limit window resets (epoch seconds), for the usage-limit reply. */
  rateLimitResetsAtSec: number | null = null;

  /** A clean policy home shares authentication but cannot load personal/project allow rules. */
  readonly policyHome: string;

  constructor(readonly binary: string, private readonly clientVersion: string) {
    this.policyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibekit-codex-policy-'));
    const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    try {
      fs.symlinkSync(path.join(sourceHome, 'auth.json'), path.join(this.policyHome, 'auth.json'));
    } catch { /* a read-only/keychain login needs no file link */ }
  }

  /** Start a turn. `stop()` interrupts it; `done` always resolves, never rejects. */
  startTurn(req: CodexTurnRequest, hooks: CodexTurnHooks): CodexTurnHandle {
    let resolve!: (end: CodexTurnEnd) => void;
    const done = new Promise<CodexTurnEnd>((r) => { resolve = r; });
    const turn: Turn = {
      translator: new CodexTurnTranslator(), hooks, threadId: null, id: null,
      conversationGeneration: this.conversationGeneration, retireThreadAfterFinish: false,
      stopRequested: false, finished: false, killTimer: null, resolve,
    };
    const previous = this.lastTurnDone;
    this.lastTurnDone = done;
    void this.drive(turn, req, previous);
    return { done, stop: () => this.stopTurn(turn) };
  }

  /** Forget the conversation: the next turn starts a new thread. */
  resetThread(): void {
    this.conversationGeneration++;
    const retired = this.threadId;
    this.threadId = null;
    this.threadCwd = null;
    this.threadAccess = null;
    this.threadNeedsResume = false;
    this.threadHasModelOverride = false;
    if (retired) this.retireThread(retired);
  }

  /**
   * Kill app-server now. The bookkeeping onExit would do happens here,
   * synchronously: once `child` is null onExit ignores this process, and the
   * next message must not wait for the exit event to learn the thread needs
   * resuming or that pending requests are dead.
   */
  dispose(): void {
    // A start in progress belongs to the process being killed. Without this,
    // the next turn awaits that doomed start and fails with it.
    this.starting = null;
    this.ready = false;
    const child = this.child;
    CodexEngine.liveEngines.delete(this);
    if (!child) return;
    this.child = null;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error('app-server was stopped'));
      this.pending.delete(id);
    }
    if (this.threadId) this.threadNeedsResume = true;
    this.retiredThreads.clear();
    try { child.kill(); } catch { /* already gone */ }
  }

  private async drive(turn: Turn, req: CodexTurnRequest, previous: Promise<unknown>): Promise<void> {
    // An interrupted turn has to finish (or be killed) before the next one starts:
    // app-server runs one turn per thread.
    await previous;
    if (turn.stopRequested) return this.finishTurn(turn, { status: 'interrupted', text: '', toolCount: 0, error: null });
    this.turn = turn;
    try {
      await this.ensureStarted();
      if (!this.loggedIn) {
        const account = await this.request('account/read', {});
        this.loggedIn = !!account?.account;
        if (!this.loggedIn) {
          // `codex login` runs in another process. A running app-server caches
          // its signed-out state, so force the resend path through a fresh one.
          this.dispose();
          return this.finishTurn(turn, { status: 'failed', text: '', toolCount: 0, error: { info: 'unauthorized', message: 'not logged in' } });
        }
      }
      if (this.models.length === 0) {
        try {
          const list = await this.request('model/list', {});
          const data: any[] = Array.isArray(list?.data) ? list.data : [];
          this.models = [...new Set(data.flatMap((m) => [m?.model, m?.id]).filter((s): s is string => typeof s === 'string' && !!s))];
        } catch { /* validation falls back to a shape check */ }
      }
      if (turn.stopRequested) return this.finishTurn(turn, turn.translator.end({ status: 'interrupted' }));

      turn.threadId = await this.ensureThread(req, turn);
      if (turn.stopRequested) return this.finishTurn(turn, turn.translator.end({ status: 'interrupted' }));

      const policy = codexPolicy(req.access);
      const input: unknown[] = [{ type: 'text', text: req.prompt, text_elements: [] }];
      for (const p of req.imagePaths) input.push({ type: 'localImage', path: p });
      const started = await this.request('turn/start', {
        threadId: turn.threadId,
        input,
        cwd: req.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
        ...(req.model ? { model: req.model } : {}),
      });
      if (req.model && this.threadId === turn.threadId && turn.conversationGeneration === this.conversationGeneration) {
        this.threadHasModelOverride = true;
      }
      if (!turn.id && typeof started?.turn?.id === 'string') turn.id = started.turn.id;
      if (turn.stopRequested) this.sendInterrupt(turn);
    } catch (e: any) {
      const message = String(e?.message || e);
      const info = /unknown (variant|field)/i.test(message)
        ? 'unsupported'
        : /initialize|initialization/i.test(message) ? 'startFailed' : this.child ? 'startFailed' : 'crashed';
      this.finishTurn(turn, { status: 'failed', text: turn.translator.text, toolCount: turn.translator.toolCount, error: { info, message } });
    }
  }

  private stopTurn(turn: Turn): void {
    if (turn.finished || turn.stopRequested) return;
    turn.stopRequested = true;
    if (this.turn === turn && turn.id) this.sendInterrupt(turn);
    // A turn that will not report `interrupted` is ended by killing app-server.
    // The thread survives on disk and is resumed by the next turn. A turn still
    // queued behind another never reached app-server, so it only finishes.
    turn.killTimer = setTimeout(() => {
      if (turn.finished) return;
      const holdsAppServer = this.turn === turn;
      this.finishTurn(turn, turn.translator.end({ status: 'interrupted' }));
      if (holdsAppServer) this.dispose();
    }, INTERRUPT_GRACE_MS);
  }

  private sendInterrupt(turn: Turn): void {
    if (!turn.threadId || !turn.id) return;
    this.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.id }).catch(() => { /* the kill timer covers it */ });
  }

  private finishTurn(turn: Turn, end: CodexTurnEnd): void {
    if (turn.finished) return;
    turn.finished = true;
    if (turn.killTimer) clearTimeout(turn.killTimer);
    if (this.turn === turn) this.turn = null;
    if (turn.id) this.lastFinishedTurnId = turn.id;
    if (end.error?.info === 'unauthorized') {
      this.loggedIn = false;
      this.dispose();
    }
    turn.resolve(end);
    if (turn.threadId) {
      if (turn.retireThreadAfterFinish) this.retiredThreads.add(turn.threadId);
      if (this.retiredThreads.has(turn.threadId)) this.unsubscribeThread(turn.threadId);
    }
  }

  private async ensureThread(req: CodexTurnRequest, turn: Turn): Promise<string> {
    if (this.threadId && (this.threadCwd !== req.cwd || this.threadAccess !== req.access)) {
      this.resetThread();
      turn.conversationGeneration = this.conversationGeneration;
    }
    // Clearing the model from chat: the old override would stay on this thread,
    // and a new thread picks up the user's own Codex default.
    if (this.threadId && this.threadHasModelOverride && !req.model) {
      this.resetThread();
      turn.conversationGeneration = this.conversationGeneration;
    }
    const generation = turn.conversationGeneration;
    const policy = codexPolicy(req.access);
    const shared = {
      cwd: req.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      config: {
        ...mcpConfig(req.mcpServers()),
        // A read-only sandbox prevents writes, but it still exposes and runs
        // shell commands. Remove the shell entirely; vkread supplies reads.
        ...(req.access === 'read-only' ? { 'features.shell_tool': false } : {}),
      },
      ...(req.model ? { model: req.model } : {}),
    };
    const existingThread = generation === this.conversationGeneration ? this.threadId : null;
    if (existingThread && this.threadNeedsResume) {
      try {
        // No `excludeTurns`: Codex before 0.153.0 gates it behind
        // experimentalApi and rejects the whole resume, which failed every
        // message after an app-server restart (verified on 0.150.0).
        await this.request('thread/resume', { threadId: existingThread, ...shared });
        if (generation === this.conversationGeneration && this.threadId === existingThread) {
          this.threadNeedsResume = false;
          this.threadAccess = req.access;
        } else {
          turn.retireThreadAfterFinish = true;
        }
        return existingThread;
      } catch (e: any) {
        // A thread whose first turn never completed was never saved.
        if (!/no rollout/i.test(String(e?.message || e))) throw e;
        if (generation === this.conversationGeneration && this.threadId === existingThread) {
          this.threadId = null;
          this.threadCwd = null;
          this.threadAccess = null;
          this.threadNeedsResume = false;
          this.threadHasModelOverride = false;
        }
      }
    }
    if (generation === this.conversationGeneration && this.threadId) return this.threadId;
    const res = await this.request('thread/start', shared);
    if (typeof res?.thread?.id !== 'string') throw new Error('thread/start returned no thread id');
    const startedThread = res.thread.id;
    if (generation === this.conversationGeneration && !this.threadId) {
      this.threadId = startedThread;
      this.threadCwd = req.cwd;
      this.threadAccess = req.access;
      this.threadNeedsResume = false;
    } else if (this.threadId !== startedThread) {
      turn.retireThreadAfterFinish = true;
    }
    return startedThread;
  }

  private retireThread(threadId: string): void {
    this.retiredThreads.add(threadId);
    if (!this.turn || this.turn.threadId !== threadId) this.unsubscribeThread(threadId);
  }

  /** Release app-server's subscription after the owning turn has consumed its final events. */
  private unsubscribeThread(threadId: string): void {
    if (!this.retiredThreads.delete(threadId) || !this.child || !this.ready) return;
    void this.request('thread/unsubscribe', { threadId }).catch(() => { /* process exit releases it too */ });
  }

  private async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child && this.ready) return;
    if (this.child) this.dispose();
    const delay = this.nextStartAt - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.starting) return this.starting;
    if (this.child && this.ready) return;
    const start = this.spawnAndInitialize();
    this.starting = start;
    // Only clear it if it is still ours: dispose() may have dropped it and a
    // newer start may already be in flight. The caller handles the rejection.
    start.then(() => {}, () => {}).then(() => { if (this.starting === start) this.starting = null; });
    return start;
  }

  private async spawnAndInitialize(): Promise<void> {
    this.stderrTail = '';
    const child = spawn(this.binary, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // A clean config/rules directory is the enforcement boundary for
      // supervised mode. auth.json is linked from the user's real Codex home.
      env: { ...process.env, PATH: searchPath(), CODEX_HOME: this.policyHome },
    });
    this.child = child;
    this.ready = false;
    this.installExitHook();

    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.onLine(child, line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8192);
    });
    child.stdin?.on('error', () => { /* EPIPE after the child died; the exit handler reports it */ });
    child.on('error', (e) => this.onExit(child, `could not start ${this.binary} (${e.message})`));
    child.on('exit', (code, signal) => this.onExit(child, `app-server exited (${signal || `code ${code}`})`, signal));

    try {
      await this.request('initialize', {
        clientInfo: { name: 'vibekit-agent', title: 'VibeKit Remote', version: this.clientVersion },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      if (this.child !== child) throw new Error('app-server was replaced during initialization');
      this.write(child, { method: 'initialized' });
      this.ready = true;
      this.nextStartAt = 0;
    } catch (error) {
      if (this.child === child) {
        this.nextStartAt = Date.now() + START_RETRY_BACKOFF_MS;
        this.dispose();
      }
      throw error;
    }
  }

  private installExitHook(): void {
    CodexEngine.liveEngines.add(this);
    if (CodexEngine.exitHookInstalled) return;
    CodexEngine.exitHookInstalled = true;
    // 'exit' listeners run synchronously on every exit, including
    // process.exit() from the self-update restart, which skips shutdown().
    process.on('exit', () => {
      for (const engine of CodexEngine.liveEngines) {
        try { engine.child?.kill(); } catch { /* already gone */ }
      }
    });
  }

  private onExit(child: ChildProcess, reason: string, signal?: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    CodexEngine.liveEngines.delete(this);
    const lastLine = this.stderrTail.trim().split('\n').pop() || '';
    // Every kill of our own goes through dispose(), which this handler
    // ignores, so a signal here came from outside the agent. Its stderr tail
    // is whatever Codex last warned about, not why it stopped: a real user
    // was told a "trusted project" notice with a temp path (2026-09-29).
    if (signal && lastLine) console.log(`Codex app-server stopped by ${signal}; its last stderr line: ${lastLine.slice(0, 300)}`);
    const detail = signal ? signal : lastLine ? `${reason}: ${lastLine.slice(0, 200)}` : reason;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(detail));
      this.pending.delete(id);
    }
    if (this.threadId) this.threadNeedsResume = true;
    this.retiredThreads.clear();
    const turn = this.turn;
    if (turn) this.finishTurn(turn, { status: 'failed', text: turn.translator.text, toolCount: turn.translator.toolCount, error: { info: signal ? 'killed' : 'crashed', message: detail } });
  }

  private write(child: ChildProcess, message: Record<string, unknown>): void {
    try { child.stdin?.write(JSON.stringify(message) + '\n'); } catch { /* the exit handler reports a dead child */ }
  }

  private request(method: string, params: unknown): Promise<any> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('Codex is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // turn/start returns as soon as the turn is accepted; the turn itself is
      // bounded by the agent's run timeout, not by this.
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write(child, { id, method, params });
    });
  }

  private onLine(child: ChildProcess, line: string): void {
    // Output a killed app-server had already buffered must not reach the next turn.
    if (child !== this.child) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new CodexRpcError(String(msg.error.message || 'request failed'), msg.error.code));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && typeof msg.method === 'string') {
      void this.onServerRequest(child, msg.id, msg.method, msg.params || {});
      return;
    }
    if (typeof msg.method === 'string') this.onNotification(msg.method, msg.params || {});
  }

  private onNotification(method: string, params: any): void {
    if (method === 'account/rateLimits/updated') {
      const limits = params?.rateLimits;
      const windows = [limits?.primary, limits?.secondary].filter(Boolean);
      const exhausted = windows.find((w: any) => typeof w?.usedPercent === 'number' && w.usedPercent >= 100) || windows[0];
      if (typeof exhausted?.resetsAt === 'number') this.rateLimitResetsAtSec = exhausted.resetsAt;
      return;
    }
    const turn = this.turn;
    if (!turn) return;
    if (params?.threadId && params.threadId !== (turn.threadId ?? this.threadId)) return;
    // Late events from a turn that already ended (an interrupt racing its tail).
    const eventTurnId = typeof params?.turnId === 'string' ? params.turnId : (typeof params?.turn?.id === 'string' ? params.turn.id : null);
    if (eventTurnId && eventTurnId === this.lastFinishedTurnId) return;
    if (turn.id && eventTurnId && eventTurnId !== turn.id) return;

    if (method === 'turn/started') {
      if (!turn.id && eventTurnId) turn.id = eventTurnId;
      if (turn.stopRequested) this.sendInterrupt(turn);
      return;
    }
    if (method === 'turn/completed') {
      this.finishTurn(turn, turn.translator.end(params?.turn));
      return;
    }
    // Stop/timeout has already produced its user-facing result. Consume only
    // the completion notification so late text and tool cards cannot follow it.
    if (turn.stopRequested) return;
    for (const output of turn.translator.handle(method, params)) turn.hooks.output(output);
    // Ending it as unauthorized disposes app-server, which stops Codex's own
    // retries of a key OpenAI has already refused.
    if (turn.translator.refused) this.finishTurn(turn, turn.translator.end({ status: 'failed' }));
  }

  private ownsApproval(child: ChildProcess, turn: Turn | null, params: any): turn is Turn {
    if (!turn || child !== this.child || this.turn !== turn || turn.finished || turn.stopRequested) return false;
    if (!turn.threadId || !turn.id) return false;
    return params?.threadId === turn.threadId && params?.turnId === turn.id;
  }

  /**
   * Every server request gets an answer. They never time out on the server
   * side, so one left unanswered hangs the turn until the run timeout.
   */
  private async onServerRequest(child: ChildProcess, id: unknown, method: string, params: any): Promise<void> {
    const reply = (result: unknown) => this.write(child, { id, result });
    const turn = this.turn;
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        if (!this.ownsApproval(child, turn, params)) return reply({ decision: 'decline' });
        const { toolName, input } = turn.translator.commandApproval(params);
        const allowed = await turn.hooks.approve(toolName, input).catch(() => false);
        return reply({ decision: allowed && this.ownsApproval(child, turn, params) ? 'accept' : 'decline' });
      }
      case 'item/fileChange/requestApproval': {
        if (!this.ownsApproval(child, turn, params)) return reply({ decision: 'decline' });
        const { toolName, input } = turn.translator.fileChangeApproval(params);
        const allowed = await turn.hooks.approve(toolName, input).catch(() => false);
        return reply({ decision: allowed && this.ownsApproval(child, turn, params) ? 'accept' : 'decline' });
      }
      case 'mcpServer/elicitation/request':
        // The self-config tools are always allowed on Claude (CONFIG_TOOL_NAMES
        // in agent.ts). Declining here would break settings-by-chat exactly in
        // supervised mode, where a loosening already gets its own phone tap.
        if (params?.serverName === VKCONFIG_SERVER && this.ownsApproval(child, turn, params)) {
          return reply({ action: 'accept', content: {}, _meta: null });
        }
        return reply({ action: 'decline', content: null, _meta: null });
      default:
        this.write(child, { id, error: { code: -32601, message: `${method} is not supported by VibeKit Remote` } });
    }
  }
}
