# vibekit-agent

Control your local Claude Code from iPhone or Telegram. Ship code from your phone.

This is VibeKit's **local bridge mode**. Your code runs on **your machine**, not in VibeKit cloud.

**Free to use** - works with your existing Claude Pro/Max subscription.

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
   Enter the code when prompted.

3. **Start the agent:**
   ```bash
   npx vibekit-agent start
   ```

4. **Send messages from iPhone or Telegram** - they'll be executed by Claude Code on your machine.

## When to Use This

Use `vibekit-agent` when you want:
- iPhone first, then Telegram, to control Claude Code on your own laptop or desktop
- to use your local Claude auth/session instead of VibeKit cloud execution
- a remote-control bridge for local development

Do **not** use it if you just want VibeKit-hosted tasks or deployments. For that, use `vibekit-cli` or `vibekit-mcp`.

## Features

- **Text messages** - Chat naturally, Claude responds
- **Voice messages** - Send voice notes, Claude listens and responds
- **Images & screenshots** - Send photos for analysis or debugging
- **Document uploads** - Share files for Claude to work with
- **Conversation memory** - Claude remembers context within a session

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
| `vibekit-agent status` | Show connection status |
| `vibekit-agent logout` | Remove stored credentials |
| `vibekit-agent config` | View current configuration |

## Tool Permissions

By default, the agent runs with a safe set of read-only tools. You can configure which tools Claude Code can use:

```bash
# View current tools
vibekit-agent config

# Set specific tools
vibekit-agent config --tools "WebSearch,Bash,Read,Write,Edit"

# Reset to safe defaults
vibekit-agent config --reset-tools

# Enable all tools (use with caution)
vibekit-agent config --all-tools
```

**Default safe tools:** WebSearch, WebFetch, Read, Glob, Grep

**Available tools:** WebSearch, WebFetch, Bash, Read, Write, Edit, Glob, Grep

## How It Works

1. The agent runs on your local machine
2. It connects to VibeKit's server via WebSocket
3. When you send a message from the iOS app or Telegram, it's relayed to your local agent
4. Claude Code executes the request and sends results back to the iOS app or Telegram

## Requirements

- Node.js 18+
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)
- A VibeKit account (free to start)

## Troubleshooting

**"No token found"** - Run `vibekit-agent link` first

**"Connection lost"** - Check your internet connection and restart with `vibekit-agent start`

**"Claude Code not found"** - Install Claude Code: `npm install -g @anthropic-ai/claude-code`

## Related Packages

- `vibekit-cli`: terminal client for VibeKit cloud workflows
- `vibekit-mcp`: MCP server for VibeKit cloud workflows

## Links

- [VibeKit Website](https://vibekit.bot/?ref=github_agent)
- [Telegram Bot](https://t.me/the_vibe_kit_bot)
- [GitHub](https://github.com/VibeKit-Bot/vibekit-agent)

## License

MIT
