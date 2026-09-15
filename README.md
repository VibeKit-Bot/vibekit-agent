# vibekit-agent

Control Claude Code or Codex on your own computer from iPhone or Telegram. Ship code from your phone.

This is VibeKit's **local bridge mode**. Your code runs on **your machine**, not in VibeKit cloud.

**Free to use** - works with your existing Claude Pro/Max subscription or your ChatGPT plan.

## Installation

```bash
npm install -g vibekit-agent
```

## Quick Start

1. **Get a link code from iPhone or Telegram:**
   - Open the VibeKit iOS app and go to `Remote`, or open [@the_vibe_kit_bot](https://t.me/the_vibe_kit_bot)
   - Tap or send `/remote` to get your link code

2. **Link your computer:**
   ```bash
   npx vibekit-agent link
   ```
   Enter the code when prompted, then press Enter to start the agent right away. For Codex, run `npx vibekit-agent link --engine codex`.

3. **Starting it later:**
   ```bash
   npx vibekit-agent start
   ```

4. **Send messages from iPhone or Telegram** - they'll be executed by Claude Code or Codex on your machine.

## Claude Code or Codex

`link` picks the coding agent for this computer: Claude Code if it is installed, otherwise Codex. To choose explicitly (remembered for next time):

```bash
npx vibekit-agent start --engine codex
npx vibekit-agent start --engine claude
```

Codex runs on your own ChatGPT account. Install it and log in on the computer first:

```bash
npm install -g @openai/codex
codex login
```

## When to Use This

Use `vibekit-agent` when you want:
- iPhone first, then Telegram, to control Claude Code or Codex on your own laptop or desktop
- to use your local Claude or ChatGPT sign-in instead of VibeKit cloud execution
- a remote-control bridge for local development

Do **not** use it if you just want VibeKit-hosted tasks or deployments. For that, use `vibekit-cli` or `vibekit-mcp`.

## Features

- **Text messages** - Chat naturally, the agent responds
- **Voice messages** - Send voice notes
- **Images & screenshots** - Send photos for analysis or debugging
- **Document uploads** - Share files for the agent to work with
- **Conversation memory** - The agent remembers context within a session
- **Ask before actions** - Approve or deny each command and edit from the app or the lock screen

## Remote Commands

Once connected, use these commands in the iOS app or bot:

| Command | Description |
|---------|-------------|
| `/remote` | View status, new chat, disconnect |
| `/stop` | Cancel running task |
| `/status` | View connection status |

## Commands

| Command | Description |
|---------|-------------|
| `vibekit-agent link` | Link this computer to your iPhone or Telegram account |
| `vibekit-agent start` | Start the remote agent |
| `vibekit-agent start -d /path/to/project` | Start in a specific directory |
| `vibekit-agent start --engine codex` | Switch this computer to Codex (or `claude`) |
| `vibekit-agent status` | Show connection status |
| `vibekit-agent logout` | Remove stored credentials |
| `vibekit-agent config` | View current configuration |

## Tool Permissions

By default the agent has full access: it edits files and runs commands on your behalf, because you linked the computer for that. You can restrict it:

```bash
# View current tools
vibekit-agent config

# Set specific tools
vibekit-agent config --tools "WebSearch,Read,Glob,Grep"

# Reset to a read-only set
vibekit-agent config --reset-tools

# Allow all tools again
vibekit-agent config --all-tools
```

**Available tools:** WebSearch, WebFetch, Bash, Read, Write, Edit, Glob, Grep

Codex has no native per-tool list, so it honors two settings: full access (all tools), or read-only (a list with no Write, Edit or Bash). In read-only mode VibeKit removes Codex's shell tool and supplies Read, Grep, Glob and LS tools confined to the selected working directory. A list that allows edits but not commands, or the reverse, is refused.

For **Ask before actions**, Remote starts Codex with a clean policy profile that shares your login but does not load local “always allow” command rules. This keeps every write and non-read command on the phone approval path.

## How It Works

1. The agent runs on your local machine
2. It connects to VibeKit's server via WebSocket
3. When you send a message from the iOS app or Telegram, it's relayed to your local agent
4. Claude Code or Codex executes the request and sends results back to the iOS app or Telegram

## Requirements

- Node.js 18+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`) or Codex CLI (`npm install -g @openai/codex`)
- A VibeKit account (free to start)

## Troubleshooting

**"No token found"** - Run `vibekit-agent link` first

**"Connection lost"** - Check your internet connection and restart with `vibekit-agent start`

**"Claude Code not found"** - Install Claude Code: `npm install -g @anthropic-ai/claude-code`

**"Codex isn't installed on this computer"** - Install Codex: `npm install -g @openai/codex`. The agent skips a `codex` that fails `codex --version`, so reinstall a broken one.

**"Codex isn't logged in on this computer"** - Run `codex login` on that computer

## Related Packages

- `vibekit-cli`: terminal client for VibeKit cloud workflows
- `vibekit-mcp`: MCP server for VibeKit cloud workflows

## Links

- [VibeKit Website](https://vibekit.bot)
- [Telegram Bot](https://t.me/the_vibe_kit_bot)
- [GitHub](https://github.com/VibeKit-Bot/vibekit-agent)

## License

MIT
