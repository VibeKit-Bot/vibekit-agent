/**
 * codex-translate.ts: turns `codex app-server` notifications into the frames
 * the VibeKit server and iOS app already render for Claude Code. Pure (no I/O),
 * so check:agentcodex pins every mapping. The process and JSON-RPC side lives
 * in codex-engine.ts. Design: docs/remote-codex-plan.md.
 *
 * THE RULE: emit Claude Code's tool names and input keys (`Bash` with
 * `command`, `Edit` with `file_path`). The server's approval summary
 * (remote-agent.ts permissionSummary), the iOS tool rows, icons and activity
 * labels, and every App Store build already on phones key on exactly those,
 * so a Codex run renders correctly with no server or app change.
 */
import type { CodexAccess } from './config';

/** Same cap as the Claude path's tool output (AgentClient.TOOL_OUTPUT_MAX_BYTES). */
export const TOOL_OUTPUT_MAX = 8 * 1024;
/** Same cap the Claude approval handler puts on each string it ships to the phone. */
export const APPROVAL_STRING_MAX = 2_000;

export interface ToolInvocation {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  outputTruncated: boolean;
}

export type CodexOutput =
  | { kind: 'text'; text: string }
  | { kind: 'status'; text: string }
  | { kind: 'tool'; tool: ToolInvocation };

export interface CodexError {
  /** codexErrorInfo's variant name (`unauthorized`, `usageLimitExceeded`, ...), or one of ours: `notInstalled`, `startFailed`, `unsupported`, `crashed`, `killed` (a signal from outside the agent). */
  info: string;
  message: string;
}

export interface CodexTurnEnd {
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  toolCount: number;
  error: CodexError | null;
}

interface FileChange {
  path: string;
  kind: { type?: string; move_path?: string | null } | null;
  diff: string;
}

export const CODEX_NOT_LOGGED_IN =
  "Codex on this computer isn't signed in, or OpenAI refused its sign-in. On that computer, run `codex login`, then send your message again.";
export const CODEX_NOT_INSTALLED =
  "Codex isn't installed on this computer. On that computer, run `npm i -g @openai/codex`, then send your message again.";

/** approvalPolicy + sandbox for each access level. `sandbox` is thread/start's string form, `sandboxPolicy` is turn/start's object form. */
export function codexPolicy(access: CodexAccess): {
  approvalPolicy: 'never' | 'untrusted';
  sandbox: 'danger-full-access' | 'read-only';
  sandboxPolicy: { type: 'dangerFullAccess' } | { type: 'readOnly'; networkAccess: boolean };
} {
  if (access === 'full') {
    // Same posture as Claude's no-prompt default (--dangerously-skip-permissions).
    return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
  }
  if (access === 'read-only') {
    // Writes and commands fail back to the model instead of asking anyone.
    return { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
  }
  // Supervised: ask the phone before every edit and every command, and run
  // what was approved as approved, the same as Claude after a tap. Measured
  // live on Codex 0.154.0 (2026-09-14): with a read-only sandbox an approved
  // command ran sandboxed, failed, and asked again (two taps per write); with
  // no sandbox it is one tap per command and one per file edit.
  return { approvalPolicy: 'untrusted', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
}

/** codexErrorInfo is a string for most variants and a one-key object for the HTTP ones. */
export function errorInfoKey(info: unknown): string {
  if (typeof info === 'string' && info) return info;
  if (info && typeof info === 'object') {
    const key = Object.keys(info)[0];
    if (key) return key;
  }
  return 'other';
}

/**
 * The error's info key, with a refused sign-in read as `unauthorized` in every
 * shape Codex reports one. A rejected API key never says `unauthorized`: each
 * retry carries `{responseStreamDisconnected: {httpStatusCode: 401}}` and the
 * final error only `other` and "unexpected status 401" (Codex 0.150.0,
 * reproduced 2026-09-29), so a real user got the raw OpenAI text.
 */
export function errorInfoFor(error: any): string {
  const info = error?.codexErrorInfo;
  const detail = info && typeof info === 'object' ? (Object.values(info)[0] as any) : null;
  if (detail?.httpStatusCode === 401) return 'unauthorized';
  if (/\bunexpected status 401\b/.test(`${error?.message ?? ''} ${error?.additionalDetails ?? ''}`)) return 'unauthorized';
  return errorInfoKey(info);
}

function inRoughly(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
  return `in about ${Math.round(hours / 24)} days`;
}

/**
 * The reply for a failed Codex run. Always sent as a normal `complete` reply,
 * never as a `status:'error'` response: iOS rewrites the text of SSE error
 * events with Claude-specific help, on every build in the wild.
 */
export function codexErrorReply(
  err: CodexError,
  ctx: { resetsAtSec?: number | null; nowMs?: number; testedVersion?: string } = {},
): string {
  switch (err.info) {
    case 'unauthorized':
      return CODEX_NOT_LOGGED_IN;
    case 'notInstalled':
      return CODEX_NOT_INSTALLED;
    case 'usageLimitExceeded': {
      const now = ctx.nowMs ?? Date.now();
      const resets = ctx.resetsAtSec ? ctx.resetsAtSec * 1000 - now : 0;
      return `Your ChatGPT plan's Codex usage limit is used up${resets > 0 ? `. It resets ${inRoughly(resets)}` : ''}. Try again then.`;
    }
    case 'rateLimitExceeded':
      return 'Codex is rate limited right now. Try again in a minute.';
    case 'serverOverloaded':
      return "OpenAI's servers are overloaded right now. Try again shortly.";
    case 'contextWindowExceeded':
      return 'This conversation is too long for Codex. Start a new conversation and try again.';
    case 'unsupported':
      return `This version of Codex isn't supported yet. On that computer, run \`npm i -g @openai/codex@${ctx.testedVersion || 'latest'}\`, then send your message again.`;
    case 'startFailed':
      return `Could not start Codex on this computer: ${err.message.slice(0, 300)}`;
    case 'crashed':
      return `Codex stopped unexpectedly (${err.message.slice(0, 200)}). Send your message again.`;
    case 'killed':
      return `Something on this computer stopped Codex (${err.message.slice(0, 20)}) before it finished. Send your message again.`;
    default:
      return `Codex reported an error: ${(err.message || 'unknown error').slice(0, 300)}`;
  }
}

export function truncatePath(filePath: string): string {
  if (filePath.length <= 40) return filePath;
  const parts = filePath.split('/');
  if (parts.length <= 2) return '...' + filePath.slice(-37);
  return '.../' + parts.slice(-2).join('/').slice(-36);
}

/**
 * The command as the user would type it. Codex runs every command through a
 * login shell, `/bin/zsh -lc '<command>'`, and an approval card reading
 * "Bash: /bin/zsh -lc 'rm notes.txt'" buries the part the user is deciding on
 * (seen in the 2026-09-14 live test). This unwraps the real command string
 * itself, not Codex's best-effort `commandActions` parse, so the card shows
 * exactly what will run.
 */
export function displayCommand(cmd: string): string {
  const m = /^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(cmd.trim());
  if (!m) return cmd;
  return m[1] === "'" ? m[2].replace(/'\\''/g, "'") : m[2].replace(/\\([\\"$`])/g, '$1');
}

function shortCommand(cmd: string): string {
  return cmd.length > 50 ? cmd.substring(0, 47) + '...' : cmd;
}

function cap(text: string, max: number, note: string): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + note, truncated: true };
}

function capString(text: string): string {
  return text.length > APPROVAL_STRING_MAX ? text.slice(0, APPROVAL_STRING_MAX) + '…' : text;
}

/** Claude's name for the change: a new file is a Write, anything else an Edit (or a Delete). */
function changeToolName(change: FileChange): 'Write' | 'Edit' | 'Delete' {
  const type = change.kind?.type;
  if (type === 'add') return 'Write';
  if (type === 'delete') return 'Delete';
  return 'Edit';
}

function asChanges(value: unknown): FileChange[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((c) => c && typeof c === 'object' && typeof (c as any).path === 'string')
    .map((c: any) => ({ path: c.path, kind: c.kind && typeof c.kind === 'object' ? c.kind : null, diff: typeof c.diff === 'string' ? c.diff : '' }));
}

function webSearchQuery(item: any): string {
  if (typeof item?.query === 'string') return item.query;
  if (typeof item?.action?.query === 'string') return item.action.query;
  if (Array.isArray(item?.action?.queries) && typeof item.action.queries[0] === 'string') return item.action.queries[0];
  return '';
}

function mcpResultText(item: any): string {
  if (typeof item?.error?.message === 'string') return item.error.message;
  const content = item?.result?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => (c && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** One Codex turn's worth of state: the reply so far, tool count, the last fatal error, and file changes awaiting approval. */
export class CodexTurnTranslator {
  text = '';
  toolCount = 0;
  /** OpenAI rejected the API key while Codex was still retrying; the engine ends the turn on it. */
  refused = false;
  private lastError: CodexError | null = null;
  /** agentMessage items that have streamed at least one delta, so their item/completed text is not appended twice. */
  private streamedItems = new Set<string>();
  /** fileChange items seen in item/started, for the approval card, which does not carry the change itself. */
  private fileChanges = new Map<string, FileChange[]>();

  handle(method: string, params: any): CodexOutput[] {
    switch (method) {
      case 'item/started':
        return this.itemStarted(params?.item);
      case 'item/agentMessage/delta': {
        const delta = typeof params?.delta === 'string' ? params.delta : '';
        if (!delta) return [];
        const id = String(params?.itemId ?? '');
        if (!this.streamedItems.has(id)) {
          this.streamedItems.add(id);
          this.separate();
        }
        this.text += delta;
        return [{ kind: 'text', text: this.text }];
      }
      case 'item/completed':
        return this.itemCompleted(params?.item);
      case 'error': {
        const e = params?.error || {};
        const info = errorInfoFor(e);
        if (params?.willRetry) {
          // A rejected API key fails every retry the same way, and Codex spends
          // ten of them before saying so (about two minutes for the user). Only
          // that code: another 401 may be a ChatGPT token Codex can refresh.
          if (!/\binvalid_api_key\b/.test(`${e.message ?? ''} ${e.additionalDetails ?? ''}`)) {
            // A transient failure Codex is already retrying: show it, keep the turn open.
            return [{ kind: 'status', text: 'Retrying after a temporary Codex error...' }];
          }
          this.refused = true;
        }
        this.lastError = { info, message: typeof e.message === 'string' ? e.message : '' };
        return [];
      }
      default:
        return [];
    }
  }

  /** The card and push for a command approval. */
  commandApproval(params: any): { toolName: string; input: Record<string, unknown> } {
    const input: Record<string, unknown> = {};
    const command = typeof params?.command === 'string' ? displayCommand(params.command) : '';
    input.command = capString(params?.kind === 'writeStdin' ? `(input to a running command) ${command}` : command);
    if (typeof params?.cwd === 'string') input.cwd = params.cwd;
    if (typeof params?.reason === 'string' && params.reason) input.reason = capString(params.reason);
    return { toolName: 'Bash', input };
  }

  /** The card and push for a file-change approval, joined to its item by id. */
  fileChangeApproval(params: any): { toolName: string; input: Record<string, unknown> } {
    const changes = this.fileChanges.get(String(params?.itemId ?? '')) || [];
    const input: Record<string, unknown> = {};
    if (typeof params?.reason === 'string' && params.reason) input.reason = capString(params.reason);
    if (changes.length === 0) {
      // The item has not been seen: say what kind of thing is asked, without waiting.
      input.file_path = 'file changes';
      return { toolName: 'Edit', input };
    }
    input.file_path = changes[0].path + (changes.length > 1 ? ` +${changes.length - 1} more` : '');
    input.diff = capString(changes.map((c) => c.diff).filter(Boolean).join('\n'));
    return { toolName: changes.every((c) => changeToolName(c) === 'Write') ? 'Write' : 'Edit', input };
  }

  /** The end of the turn, from turn/completed's `turn`. */
  end(turn: any): CodexTurnEnd {
    const status = turn?.status === 'completed' || turn?.status === 'interrupted' ? turn.status : 'failed';
    let error = this.lastError;
    if (status === 'failed' && !error && turn?.error) {
      error = { info: errorInfoFor(turn.error), message: typeof turn.error.message === 'string' ? turn.error.message : '' };
    }
    return { status, text: this.text, toolCount: this.toolCount, error: status === 'completed' ? null : error };
  }

  private separate(): void {
    if (this.text && !/\s$/.test(this.text)) this.text += '\n\n';
  }

  private itemStarted(item: any): CodexOutput[] {
    switch (item?.type) {
      case 'commandExecution':
        return [{ kind: 'status', text: `Bash: ${shortCommand(displayCommand(String(item.command ?? '')))}` }];
      case 'fileChange': {
        const changes = asChanges(item.changes);
        this.fileChanges.set(String(item.id ?? ''), changes);
        if (changes.length === 0) return [];
        return [{ kind: 'status', text: `${changeToolName(changes[0])}: ${truncatePath(changes[0].path)}` }];
      }
      case 'webSearch':
        return [{ kind: 'status', text: `Search: ${webSearchQuery(item).substring(0, 40)}` }];
      case 'mcpToolCall':
        return [{ kind: 'status', text: `mcp__${item.server}__${item.tool}` }];
      default:
        return [];
    }
  }

  private itemCompleted(item: any): CodexOutput[] {
    const id = String(item?.id ?? '');
    switch (item?.type) {
      case 'agentMessage': {
        // Streamed already: the deltas built the same text.
        if (this.streamedItems.has(id) || typeof item.text !== 'string' || !item.text) return [];
        this.streamedItems.add(id);
        this.separate();
        this.text += item.text;
        return [{ kind: 'text', text: this.text }];
      }
      case 'commandExecution': {
        this.toolCount++;
        const declined = item.status === 'declined';
        const raw = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
        const out = cap(raw || (declined ? 'Declined' : ''), TOOL_OUTPUT_MAX, '');
        const input: Record<string, unknown> = { command: displayCommand(String(item.command ?? '')) };
        if (typeof item.cwd === 'string') input.cwd = item.cwd;
        return [{
          kind: 'tool',
          tool: {
            toolCallId: id,
            name: 'Bash',
            input,
            output: out.text,
            isError: item.status === 'failed' || declined || (typeof item.exitCode === 'number' && item.exitCode !== 0),
            outputTruncated: out.truncated,
          },
        }];
      }
      case 'fileChange': {
        const changes = asChanges(item.changes).length ? asChanges(item.changes) : (this.fileChanges.get(id) || []);
        this.fileChanges.delete(id);
        const failed = item.status === 'failed' || item.status === 'declined';
        const outcome = item.status === 'declined' ? 'Declined' : item.status === 'failed' ? 'Failed' : '';
        return changes.map((change, index) => {
          this.toolCount++;
          const name = changeToolName(change);
          const diff = cap(change.diff, TOOL_OUTPUT_MAX, '\n... diff truncated');
          const verb = name === 'Write' ? 'Created' : name === 'Delete' ? 'Deleted' : 'Updated';
          return {
            kind: 'tool' as const,
            tool: {
              // The server's stream buffer replaces entries that share a
              // toolCallId (remote-agent.ts), so each file needs its own.
              toolCallId: `${id}:${index}`,
              name,
              input: { file_path: change.path, diff: diff.text },
              output: outcome || `${verb} ${change.path}`,
              isError: failed,
              outputTruncated: false,
            },
          };
        });
      }
      case 'mcpToolCall': {
        this.toolCount++;
        const args = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
          ? item.arguments as Record<string, unknown>
          : (item.arguments == null ? {} : { arguments: item.arguments });
        const out = cap(mcpResultText(item), TOOL_OUTPUT_MAX, '');
        return [{
          kind: 'tool',
          tool: { toolCallId: id, name: `mcp__${item.server}__${item.tool}`, input: args, output: out.text, isError: item.status === 'failed', outputTruncated: out.truncated },
        }];
      }
      case 'webSearch': {
        this.toolCount++;
        return [{
          kind: 'tool',
          tool: { toolCallId: id, name: 'WebSearch', input: { query: webSearchQuery(item) }, output: '', isError: false, outputTruncated: false },
        }];
      }
      default:
        return [];
    }
  }
}
