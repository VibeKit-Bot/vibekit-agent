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

interface ConfigData {
  token?: string;
  wsUrl?: string;
  lastDirectory?: string;
  allowedTools?: string[];
  credentialsFile?: string;
  isAutoMode?: boolean;
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

  clear(): void {
    this.data = {};
    if (fs.existsSync(this.configPath)) {
      fs.unlinkSync(this.configPath);
    }
  }
}
