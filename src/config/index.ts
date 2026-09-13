import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';
import { SandalConfig, DbAgentConfig, ResolvedCredentials, LLMProvider } from './types.js';
export * from './models.js';

// Load .env from current directory if present
dotenv.config();

const CONFIG_DIR_NAME = '.sandal';
const LEGACY_CONFIG_DIR_NAME = '.db-agent';
const CONFIG_FILE_NAME = 'config.json';

export function getConfigDirPath(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

export function getConfigFilePath(): string {
  return path.join(getConfigDirPath(), CONFIG_FILE_NAME);
}

export function getLegacyConfigFilePath(): string {
  return path.join(os.homedir(), LEGACY_CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/**
 * Reads the config file from ~/.sandal/config.json (falling back to ~/.db-agent/config.json).
 * Returns empty config if file doesn't exist or is invalid.
 */
export function readConfig(): SandalConfig {
  const filePath = getConfigFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as SandalConfig;
    }
    const legacyPath = getLegacyConfigFilePath();
    if (fs.existsSync(legacyPath)) {
      const content = fs.readFileSync(legacyPath, 'utf-8');
      return JSON.parse(content) as SandalConfig;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Writes config to ~/.sandal/config.json with chmod 600 permissions.
 */
export function writeConfig(newConfig: Partial<SandalConfig>): void {
  const dirPath = getConfigDirPath();
  const filePath = getConfigFilePath();

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }

  const existing = readConfig();
  const merged: SandalConfig = {
    ...existing,
    ...newConfig,
  };

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });

  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows file permissions may not support POSIX octal modes, safely ignored
  }
}

/**
 * Mask sensitive credentials for safe terminal and log display.
 * E.g., postgres://user:password@localhost:5432/mydb -> postgres://user:***@localhost:5432/mydb
 * E.g., AIzaSyD-12345678 -> AIza...5678
 */
export function maskUrl(rawUrl?: string): string {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    if (url.password) {
      url.password = '***';
    }
    if (url.username && url.username.length > 2) {
      url.username = url.username[0] + '***';
    }
    return url.toString();
  } catch {
    // Regex fallback for non-standard URI formats like mongodb+srv://
    return rawUrl.replace(/(:\/\/)([^:@\s]+):([^@\s]+)@/g, '$1$2:***@');
  }
}

export function maskApiKey(rawKey?: string): string {
  if (!rawKey) return '';
  const trimmed = rawKey.trim();
  if (trimmed.length <= 8) {
    return '***';
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/**
 * Check if an API key is stored (in env or config) for a specific provider.
 */
export function getStoredApiKeyForProvider(provider: LLMProvider): string | undefined {
  const config = readConfig();
  switch (provider) {
    case 'google':
      return process.env.GEMINI_API_KEY || config.geminiApiKey;
    case 'openai':
      return process.env.OPENAI_API_KEY || config.openaiApiKey;
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY || config.anthropicApiKey;
  }
}

/**
 * Determine default model name for each provider.
 */
export function getDefaultModelForProvider(provider: LLMProvider): string {
  switch (provider) {
    case 'google':
      return 'gemini-2.5-flash';
    case 'openai':
      return 'gpt-4o';
    case 'anthropic':
      return 'claude-3-5-sonnet-latest';
  }
}

/**
 * Resolve DB URL and LLM credentials according to strict precedence:
 * CLI flag / argument > Environment Variable > Stored Config File > Prompt
 */
export function resolveCredentials(options: {
  cliDbUrl?: string;
  cliApiKey?: string;
  cliProvider?: string;
  cliModel?: string;
}): ResolvedCredentials {
  const config = readConfig();

  // 1. Resolve DB URL
  let dbUrl: string | undefined = options.cliDbUrl;
  let dbSource: ResolvedCredentials['source']['dbUrl'] = 'cli';

  if (!dbUrl) {
    const envUrl = process.env.DATABASE_URL || process.env.DB_URL;
    if (envUrl) {
      dbUrl = envUrl;
      dbSource = 'env';
    } else if (config.dbUrl) {
      dbUrl = config.dbUrl;
      dbSource = 'config';
    } else {
      dbSource = 'none';
    }
  }

  // 2. Resolve Provider
  let provider: LLMProvider = 'google';
  if (options.cliProvider) {
    const p = options.cliProvider.toLowerCase();
    if (p === 'openai' || p === 'anthropic' || p === 'google') {
      provider = p;
    }
  } else if (config.defaultProvider) {
    provider = config.defaultProvider;
  } else if (process.env.GEMINI_API_KEY) {
    provider = 'google';
  } else if (process.env.OPENAI_API_KEY) {
    provider = 'openai';
  } else if (process.env.ANTHROPIC_API_KEY) {
    provider = 'anthropic';
  }

  // 3. Resolve API Key for chosen/available provider
  let apiKey: string | undefined = options.cliApiKey;
  let keySource: ResolvedCredentials['source']['apiKey'] = 'cli';

  if (!apiKey) {
    if (provider === 'google') {
      if (process.env.GEMINI_API_KEY) {
        apiKey = process.env.GEMINI_API_KEY;
        keySource = 'env';
      } else if (config.geminiApiKey) {
        apiKey = config.geminiApiKey;
        keySource = 'config';
      }
    } else if (provider === 'openai') {
      if (process.env.OPENAI_API_KEY) {
        apiKey = process.env.OPENAI_API_KEY;
        keySource = 'env';
      } else if (config.openaiApiKey) {
        apiKey = config.openaiApiKey;
        keySource = 'config';
      }
    } else if (provider === 'anthropic') {
      if (process.env.ANTHROPIC_API_KEY) {
        apiKey = process.env.ANTHROPIC_API_KEY;
        keySource = 'env';
      } else if (config.anthropicApiKey) {
        apiKey = config.anthropicApiKey;
        keySource = 'config';
      }
    }

    // Fallback: ONLY if chosen provider was NOT explicitly specified in CLI flags, check other providers
    if (!apiKey && !options.cliProvider) {
      if (process.env.GEMINI_API_KEY || config.geminiApiKey) {
        provider = 'google';
        apiKey = process.env.GEMINI_API_KEY || config.geminiApiKey;
        keySource = process.env.GEMINI_API_KEY ? 'env' : 'config';
      } else if (process.env.OPENAI_API_KEY || config.openaiApiKey) {
        provider = 'openai';
        apiKey = process.env.OPENAI_API_KEY || config.openaiApiKey;
        keySource = process.env.OPENAI_API_KEY ? 'env' : 'config';
      } else if (process.env.ANTHROPIC_API_KEY || config.anthropicApiKey) {
        provider = 'anthropic';
        apiKey = process.env.ANTHROPIC_API_KEY || config.anthropicApiKey;
        keySource = process.env.ANTHROPIC_API_KEY ? 'env' : 'config';
      } else {
        keySource = 'none';
      }
    } else if (!apiKey) {
      keySource = 'none';
    }
  }

    // 4. Resolve Model
  const model =
    options.cliModel ||
    config.defaultModel ||
    getDefaultModelForProvider(provider);

  return {
    dbUrl,
    apiKey,
    provider,
    model,
    source: {
      dbUrl: dbSource,
      apiKey: keySource,
    },
  };
}

/**
 * Removes stored API key(s) from ~/.sandal/config.json.
 */
export function removeApiKey(provider: LLMProvider | 'all'): void {
  const filePath = getConfigFilePath();
  const dirPath = getConfigDirPath();
  const cfg = readConfig();

  if (provider === 'all') {
    delete cfg.geminiApiKey;
    delete cfg.openaiApiKey;
    delete cfg.anthropicApiKey;
  } else if (provider === 'google') {
    delete cfg.geminiApiKey;
  } else if (provider === 'openai') {
    delete cfg.openaiApiKey;
  } else if (provider === 'anthropic') {
    delete cfg.anthropicApiKey;
  }

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });

  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Safely ignore on Windows
  }
}

/**
 * Retrieve saved database connections history from config.
 */
export function getSavedConnections(): string[] {
  const cfg = readConfig();
  const list = Array.isArray(cfg.savedConnections) ? [...cfg.savedConnections] : [];
  if (cfg.dbUrl && !list.includes(cfg.dbUrl)) {
    list.unshift(cfg.dbUrl);
  }
  return list;
}

/**
 * Add a connection to saved connection history in config.
 * Moves to front if already present. Caps at 20 entries.
 */
export function addSavedConnection(rawUrl: string): void {
  if (!rawUrl || typeof rawUrl !== 'string') return;
  const trimmed = rawUrl.trim();
  if (!trimmed) return;

  const current = getSavedConnections();
  const filtered = current.filter((u) => u !== trimmed);
  const updated = [trimmed, ...filtered].slice(0, 20);

  writeConfig({
    savedConnections: updated,
  });
}

/**
 * Remove a connection from saved history by URL string or 1-based index.
 */
export function removeSavedConnection(target: string | number): boolean {
  const current = getSavedConnections();
  let updated: string[];

  if (typeof target === 'number') {
    const idx = target - 1;
    if (idx < 0 || idx >= current.length) return false;
    updated = current.filter((_, i) => i !== idx);
  } else {
    const normalized = target.trim();
    if (!current.includes(normalized)) return false;
    updated = current.filter((u) => u !== normalized);
  }

  writeConfig({
    savedConnections: updated,
  });
  return true;
}

