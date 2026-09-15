import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Legacy constant — kept exported for backwards compatibility. No longer used
// as the default: Remote mode assumes the user has intentionally linked their
// device and expects the agent to make actual changes (Edit, Write, Bash).
// Users who want a restricted allowlist can still set `allowedTools` in
// ~/.vibekit/config.json to override the no-restrictions default.
export const DEFAULT_ALLOWED_TOOLS = [
  'WebSearch',
  'WebFetch',
  'Read',
  'Glob',
  'Grep',
];

/**
 * Model names `claude -p --model` accepts: the three tier aliases, or a full
 * published id. Deliberately a shape check rather than a pinned list — model
 * ids change faster than this package ships, and a stale allowlist would
 * reject a model claude handles fine. What it DOES catch is the failure that
 * matters: a typo or a hallucinated name silently poisoning every subsequent
 * run, since --model is passed on each spawn and a bad one fails the whole turn.
 */
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku'];
const MODEL_ID_RE = /^claude-[a-z0-9][a-z0-9.-]{2,63}$/i;
/** Codex model slugs (gpt-6-astra, gpt-5.6-sol, ...). The agent also checks the live model/list when it has one. */
const CODEX_MODEL_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

/** Which coding agent this machine runs. Chosen at `link`, changed with `start --engine`. */
export type Engine = 'claude' | 'codex';
export const ENGINES: readonly Engine[] = ['claude', 'codex'];

export function isValidModel(model: string, engine: Engine = 'claude'): boolean {
  const m = model.trim();
  if (engine === 'codex') return CODEX_MODEL_RE.test(m);
  return MODEL_ALIASES.includes(m.toLowerCase()) || MODEL_ID_RE.test(m);
}

/**
 * Codex has no per-tool allowlist, so a Claude-style `allowedTools` list maps
 * to one of three access levels. See docs/remote-codex-plan.md section 5.
 *   full       no restrictions (an empty list, or one allowing both edits and commands)
 *   read-only  no edits and no commands
 *   ask        supervised: the phone approves every write and command
 */
export type CodexAccess = 'full' | 'read-only' | 'ask';
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const EXEC_TOOLS = ['Bash'];
/** What a Codex agent reports for read-only, in the shape the phone already renders ("4 tools only"). */
export const CODEX_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];

export function codexAccessFor(allowedTools: string[], supervised: boolean): CodexAccess {
  if (supervised) return 'ask';
  if (allowedTools.length === 0) return 'full';
  const writes = allowedTools.some((t) => WRITE_TOOLS.includes(t));
  const execs = allowedTools.some((t) => EXEC_TOOLS.includes(t));
  // A half list (edits without commands, or the reverse) cannot be honored.
  // It applies as read-only, never as full access.
  return writes && execs ? 'full' : 'read-only';
}

/** Why Codex cannot honor this list, or null when it can. */
export function codexToolListProblem(allowedTools: string[]): string | null {
  if (allowedTools.length === 0) return null;
  const writes = allowedTools.some((t) => WRITE_TOOLS.includes(t));
  const execs = allowedTools.some((t) => EXEC_TOOLS.includes(t));
  if (writes === execs) return null;
  const what = writes ? 'file edits without also allowing commands' : 'commands without also allowing file edits';
  return `Codex can't allow ${what}. Choose full access (an empty list) or a read-only list like ["Read","Grep"].`;
}

/** The tool list a Codex agent reports upward: the access in force, never a list it cannot honor. */
export function codexReportedTools(allowedTools: string[]): string[] {
  return codexAccessFor(allowedTools, false) === 'full' ? [] : [...CODEX_READ_ONLY_TOOLS];
}

/** The only settings a conversation may change. Everything absent from this
 *  list is refused by name rather than ignored — see `CONFIG_CHANGE_KEYS`
 *  usage in agent.ts. `token`, `wsUrl`, `credentialsFile` and `isAutoMode` are
 *  pairing identity, not preferences: a chat-writable `wsUrl` would re-point
 *  the agent at an arbitrary server and hand over the machine. */
export const CONFIG_CHANGE_KEYS = ['model', 'allowedTools', 'cwd', 'supervised'] as const;

export interface ConfigChange {
  model?: string | null;
  allowedTools?: string[];
  cwd?: string;
  supervised?: boolean;
}

/**
 * Which parts of a requested change REDUCE the agent's safety posture.
 * Returns one human-readable phrase per loosening, empty when there are none.
 *
 * This exists because the agent reads repos, issue text and web pages, so the
 * realistic attack is a poisoned file telling it to disable supervised mode.
 * Tightening applies freely; anything listed here costs a tap on the phone.
 *
 * MIND THE DIRECTION OF `allowedTools`. An EMPTY list means NO restrictions
 * (the agent passes --dangerously-skip-permissions); any non-empty list is a
 * restriction. So emptying the list is the dangerous move and filling it is
 * the safe one, which is the exact inverse of how it reads. Getting this
 * backwards would wave through every loosening and gate every tightening,
 * which is why it is a pure function with its own tests.
 */
export function describeLoosenings(
  current: { allowedTools: string[]; supervised: boolean },
  next: ConfigChange,
): string[] {
  const out: string[] = [];

  if (next.supervised === false && current.supervised) {
    out.push('turning supervised mode off');
  }

  if (next.allowedTools) {
    if (current.allowedTools.length > 0) {
      if (next.allowedTools.length === 0) {
        out.push('removing all tool restrictions');
      } else {
        const added = next.allowedTools.filter((t) => !current.allowedTools.includes(t));
        if (added.length > 0) out.push(`allowing ${added.join(', ')}`);
      }
    }
    // current.allowedTools empty = already unrestricted, so any list is a
    // tightening and nothing here is a loosening.
  }

  // model and cwd change what the agent runs, not what it is permitted to do.
  return out;
}

interface ConfigData {
  token?: string;
  wsUrl?: string;
  lastDirectory?: string;
  allowedTools?: string[];
  credentialsFile?: string;
  isAutoMode?: boolean;
  /** Passed to `claude -p --model`. Unset = whatever the user's claude
   *  install defaults to, which is the behaviour that shipped before this
   *  key existed. */
  model?: string;
  /** Unset = linked by a version before Codex support, which means Claude. */
  engine?: Engine;
}

export class Config {
  readonly configDir: string;
  readonly configPath: string;
  private data: ConfigData;

  constructor() {
    this.configDir = path.join(os.homedir(), '.vibekit');
    this.configPath = path.join(this.configDir, 'config.json');
    this.data = this.load();
  }

  /**
   * Create a Config instance for auto mode (Docker containers)
   * Uses provided credentials instead of loading from file
   */
  static fromAutoMode(wsUrl: string, token: string, credentialsFile?: string): Config {
    const config = new Config();
    config.data = {
      wsUrl,
      token,
      credentialsFile,
      isAutoMode: true,
      allowedTools: [], // No restrictions in auto mode - user's own subscription
    };
    return config;
  }

  isAutoMode(): boolean {
    return this.data.isAutoMode || false;
  }

  getCredentialsFile(): string | undefined {
    return this.data.credentialsFile;
  }

  private load(): ConfigData {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.error('Error loading config:', error);
    }
    return {};
  }

  private save(): void {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error('Error saving config:', error);
    }
  }

  hasToken(): boolean {
    return !!this.data.token && !!this.data.wsUrl;
  }

  getToken(): string | undefined {
    return this.data.token;
  }

  getWsUrl(): string | undefined {
    return this.data.wsUrl;
  }

  getLastDirectory(): string | undefined {
    return this.data.lastDirectory;
  }

  setCredentials(token: string, wsUrl: string): void {
    this.data.token = token;
    this.data.wsUrl = wsUrl;
    this.save();
  }

  setLastDirectory(directory: string): void {
    this.data.lastDirectory = directory;
    this.save();
  }

  getAllowedTools(): string[] {
    // Default: empty array → agent passes --dangerously-skip-permissions so Edit,
    // Write, and Bash work without interactive prompts. That's the intended shape
    // of Remote mode: you linked the device knowing it acts on your behalf.
    // If you want a restricted allowlist, set `allowedTools` in ~/.vibekit/config.json.
    return this.data.allowedTools || [];
  }

  setAllowedTools(tools: string[]): void {
    this.data.allowedTools = tools;
    this.save();
  }

  getModel(): string | undefined {
    return this.data.model;
  }

  /** `null` clears the override and goes back to the install's default. */
  setModel(model: string | null): void {
    if (model === null) {
      delete this.data.model;
    } else {
      const engine = this.data.engine || 'claude';
      if (!isValidModel(model, engine)) throw new Error(`Not a model name ${engine} accepts: ${model}`);
      this.data.model = model.trim();
    }
    this.save();
  }

  getEngine(): Engine | undefined {
    return this.data.engine;
  }

  /**
   * A model override belongs to one engine: "opus" sent to Codex, or a GPT slug
   * sent to `claude --model`, fails every message. So switching engines clears
   * it. No stored engine means Claude. Returns the override it cleared, if any.
   */
  setEngine(engine: Engine): string | undefined {
    let cleared: string | undefined;
    if ((this.data.engine ?? 'claude') !== engine && this.data.model) {
      cleared = this.data.model;
      delete this.data.model;
    }
    this.data.engine = engine;
    this.save();
    return cleared;
  }

  clear(): void {
    this.data = {};
    if (fs.existsSync(this.configPath)) {
      fs.unlinkSync(this.configPath);
    }
  }
}
