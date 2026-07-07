#!/usr/bin/env node

import { Command } from 'commander';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { AgentClient } from './agent';
import { Config, DEFAULT_ALLOWED_TOOLS } from './config';

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
  .description('Control your local Claude Code via iOS or Telegram')
  .version(CLI_VERSION);

program
  .command('link')
  .description('Link this computer to your iPhone or Telegram account')
  .action(async () => {
    const config = new Config();
    const agent = new AgentClient(config);
    await agent.link();
  });

program
  .command('start')
  .description('Start the remote agent')
  .option('-d, --directory <path>', 'Working directory', process.cwd())
  .option('--auto', 'Auto mode - use environment variables for config (for Docker containers)')
  .option('--ws-url <url>', 'WebSocket URL (auto mode)')
  .option('--token <token>', 'Authentication token (auto mode)')
  .option('--credentials-file <path>', 'Claude credentials file path (auto mode)')
  .action(async (options) => {
    let config: Config;

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

      if (!config.hasToken()) {
        console.error('No token found. Run "vibekit-agent link" first.');
        process.exit(1);
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
      config.setAllowedTools(tools);
      console.log('Allowed tools set to:', tools.join(', '));
      return;
    }

    // No options - show current config
    const tools = config.getAllowedTools();
    console.log('Current configuration:');
    console.log(`  Config file: ${config.configPath}`);
    console.log(`  Linked: ${config.hasToken() ? 'Yes' : 'No'}`);
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
