import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';
import { DbAgentConfig, ResolvedCredentials, LLMProvider } from './types.js';

// Load .env from current directory if present
dotenv.config();

const CONFIG_DIR_NAME = '.db-agent';
const CONFIG_FILE_NAME = 'config.json';

export function getConfigDirPath(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

export function getConfigFilePath(): string {
  return path.join(getConfigDirPath(), CONFIG_FILE_NAME);
}

/**
 * Reads the config file from ~/.db-agent/config.json.
 * Returns empty config if file doesn't exist or is invalid.
 */
export function readConfig(): DbAgentConfig {
  const filePath = getConfigFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as DbAgentConfig;
  } catch {
    return {};
  }
}

/**
 * Writes config to ~/.db-agent/config.json with chmod 600 permissions.
 */
export function writeConfig(newConfig: Partial<DbAgentConfig>): void {
  const dirPath = getConfigDirPath();
  const filePath = getConfigFilePath();

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }

  const existing = readConfig();
  const merged: DbAgentConfig = {
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

    // Fallback: if chosen provider has no key, check other providers
    if (!apiKey) {
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
