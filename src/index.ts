#!/usr/bin/env node

import { Command } from 'commander';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { AgentClient } from './agent';
import { Config, DEFAULT_ALLOWED_TOOLS, Engine, codexToolListProblem, parseEngine } from './config';

const program = new Command();

// Read the version from package.json so `--version` never drifts from the
// published version (it was hardcoded to '1.2.1' and silently went stale).
const CLI_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version || 'unknown';
  } catch { return 'unknown'; }
})();

program
  .name('vibekit-agent')
  .description('Control Claude Code or Codex on this computer from the VibeKit app')
  .version(CLI_VERSION);

// How often an unlinked supervised agent re-checks for a pairing. Reading one
// small JSON file, so the interval is about responsiveness, not cost.
const PAIRING_POLL_MS = 10_000;

/**
 * "Not linked" is a state only a human can clear, so exiting is the one thing
 * that must not happen under a supervisor: pm2/systemd read the exit as a crash
 * and restart forever. That turned a single expired pairing into 869,000 pm2
 * restarts and 87,380 identical log lines on our own box (2026-08-04) — the
 * spin produced no progress, only noise, and buried the one line that mattered.
 *
 * Interactively the exit is still right: a person who typed `start` wants their
 * prompt back with a non-zero status. So the TTY check is the fork — a human
 * gets the error, a supervisor gets an agent that waits and then starts itself
 * the moment `vibekit-agent link` writes the pairing, with no pm2 command to run.
 */
async function waitForPairing(): Promise<Config> {
  if (process.stdout.isTTY) {
    console.error('No token found. Run "vibekit-agent link" first.');
    process.exit(1);
  }
  // Under a supervisor, an unpaired agent waiting is a normal state (it is
  // what an unlink from the app leaves behind), so it goes to stdout. On
  // stderr it read as an error to pm2 and to the admin Remote Errors panel.
  console.log('Not linked yet. Waiting for a pairing: this agent starts on its own once you run "vibekit-agent link".');
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, PAIRING_POLL_MS));
    const linked = new Config();
    if (linked.hasToken()) {
      console.log('Pairing found. Starting.');
      return linked;
    }
  }
}

/**
 * The coding agent named after the command (`link codex`, `start claude`), or
 * with the `--engine` flag that 1.6.0 and 1.6.1 documented. The word reads the
 * way people say it; the flag keeps instructions already out there working.
 */
function engineFromArgs(word: string | undefined, flag: string | undefined): Engine | undefined {
  const raw = word ?? flag;
  if (raw === undefined) return undefined;
  const engine = parseEngine(raw);
  if (!engine) {
    console.error(`Unknown coding agent "${raw}". Use claude or codex, for example: vibekit-agent link codex`);
    process.exit(1);
  }
  return engine;
}

program
  .command('link [agent]')
  .description('Link this computer to your iPhone or Telegram account. Add claude or codex to pick the coding agent.')
  .option('--engine <engine>', 'Same as the agent argument (older form)')
  .action(async (agentWord: string | undefined, options) => {
    const engine = engineFromArgs(agentWord, options.engine);
    const config = new Config();
    const agent = new AgentClient(config);
    await agent.link(engine);
  });

program
  .command('start [agent]')
  .description('Start the remote agent. Add claude or codex to switch the coding agent (remembered).')
  .option('-d, --directory <path>', 'Working directory', process.cwd())
  .option('--auto', 'Auto mode - use environment variables for config (for Docker containers)')
  .option('--ws-url <url>', 'WebSocket URL (auto mode)')
  .option('--token <token>', 'Authentication token (auto mode)')
  .option('--credentials-file <path>', 'Claude credentials file path (auto mode)')
  .option('--engine <engine>', 'Same as the agent argument (older form)')
  .action(async (agentWord: string | undefined, options) => {
    let config: Config;

    const engine = engineFromArgs(agentWord, options.engine);
    if (options.auto && engine === 'codex') {
      console.error('Auto mode runs Claude Code only.');
      process.exit(1);
    }

    if (options.auto) {
      // Auto mode: get config from command line args or environment variables
      const wsUrl = options.wsUrl || process.env.CALLBACK_URL;
      const token = options.token || process.env.CONTAINER_TOKEN;
      const credentialsFile = options.credentialsFile || process.env.CLAUDE_CREDENTIALS_FILE;

      if (!wsUrl || !token) {
        console.error('Auto mode requires --ws-url and --token (or CALLBACK_URL and CONTAINER_TOKEN env vars)');
        process.exit(1);
      }

      config = Config.fromAutoMode(wsUrl, token, credentialsFile);
      console.log('[AutoMode] Running in Docker container mode');
    } else {
      config = new Config();

      if (!config.hasToken()) config = await waitForPairing();
      if (engine) {
        const cleared = config.setEngine(engine);
        if (cleared) console.log(`Cleared the model setting "${cleared}": it was for the other coding agent.`);
      }
    }

    const agent = new AgentClient(config);
    await agent.start(options.directory, options.auto);
  });

program
  .command('status')
  .description('Show agent status')
  .action(() => {
    const config = new Config();

    if (!config.hasToken()) {
      console.log('Status: Not linked');
      console.log('Run "vibekit-agent link" to connect to iOS or Telegram.');
      return;
    }

    console.log('Status: Linked');
    console.log(`Config: ${config.configPath}`);
    console.log('\nRun "vibekit-agent start" to begin.');
  });

program
  .command('logout')
  .description('Remove stored credentials')
  .action(() => {
    const config = new Config();
    config.clear();
    console.log('Credentials removed. Run "vibekit-agent link" to reconnect.');
  });

program
  .command('config')
  .description('Configure agent settings')
  .option('--tools <tools>', 'Comma-separated list of allowed tools (e.g., "WebSearch,Bash,Read")')
  .option('--reset-tools', 'Reset tools to default safe set')
  .option('--all-tools', 'Allow all tools (use with caution)')
  .action(async (options) => {
    const config = new Config();

    if (options.resetTools) {
      config.setAllowedTools(DEFAULT_ALLOWED_TOOLS);
      console.log('Tools reset to defaults:', DEFAULT_ALLOWED_TOOLS.join(', '));
      return;
    }

    if (options.allTools) {
      console.log('\nWARNING: Enabling ALL tools gives Claude Code full access including:');
      console.log('   • Write/Edit: Can modify any file in your working directory');
      console.log('   • Bash: Can execute any shell command\n');

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question('Type "yes" to confirm: ', resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== 'yes') {
        console.log('Cancelled.');
        process.exit(0);
      }

      config.setAllowedTools([]);
      console.log('All tools enabled. Claude Code will have full access.');
      return;
    }

    if (options.tools) {
      const tools = options.tools.split(',').map((t: string) => t.trim()).filter(Boolean);
      const problem = config.getEngine() === 'codex' ? codexToolListProblem(tools) : null;
      if (problem) {
        console.error(problem);
        process.exit(1);
      }
      config.setAllowedTools(tools);
      console.log('Allowed tools set to:', tools.join(', '));
      return;
    }

    // No options - show current config
    const tools = config.getAllowedTools();
    console.log('Current configuration:');
    console.log(`  Config file: ${config.configPath}`);
    console.log(`  Linked: ${config.hasToken() ? 'Yes' : 'No'}`);
    console.log(`  Engine: ${config.getEngine() === 'codex' ? 'Codex' : 'Claude Code'}`);
    if (tools.length === 0) {
      console.log('  Allowed tools: ALL (no restrictions)');
    } else {
      console.log(`  Allowed tools: ${tools.join(', ')}`);
    }
    console.log('');
    console.log('Available tools: WebSearch, WebFetch, Bash, Read, Write, Edit, Glob, Grep');
    console.log('');
    console.log('Examples:');
    console.log('  vibekit-agent config --tools "WebSearch,Bash,Read,Write,Edit"');
    console.log('  vibekit-agent config --reset-tools');
    console.log('  vibekit-agent config --all-tools');
  });

program.parse();
