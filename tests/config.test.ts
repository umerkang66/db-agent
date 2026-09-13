import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { maskUrl, maskApiKey, resolveCredentials } from '../src/config/index.js';

describe('Configuration & Credential Masking', () => {
  it('masks database URL passwords and usernames correctly', () => {
    const maskedPg = maskUrl('postgres://admin:secretpassword123@localhost:5432/prod_db');
    expect(maskedPg).not.toContain('secretpassword123');
    expect(maskedPg).toContain('***');
    expect(maskedPg).toContain('prod_db');

    const maskedMongo = maskUrl('mongodb+srv://cluster_user:supersecretpass@cluster.mongodb.net/analytics');
    expect(maskedMongo).not.toContain('supersecretpass');
    expect(maskedMongo).toContain('***');
  });

  it('masks API keys leaving only first 4 and last 4 chars', () => {
    const key = 'sk-proj-9876543210abcdef';
    const masked = maskApiKey(key);
    expect(masked).toBe('sk-p...cdef');
    expect(masked).not.toContain('9876543210');

    expect(maskApiKey('12345')).toBe('***');
    expect(maskApiKey('')).toBe('');
  });

  describe('Credential Precedence (CLI > ENV > Config)', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      delete process.env.DATABASE_URL;
      delete process.env.DB_URL;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('prefers CLI argument over ENV and config for DB URL', () => {
      process.env.DATABASE_URL = 'postgres://env_user:env_pass@localhost/envdb';

      const res = resolveCredentials({
        cliDbUrl: 'postgres://cli_user:cli_pass@localhost/clidb',
      });

      expect(res.dbUrl).toBe('postgres://cli_user:cli_pass@localhost/clidb');
      expect(res.source.dbUrl).toBe('cli');
    });

    it('prefers ENV variable over config when CLI argument is omitted', () => {
      process.env.DATABASE_URL = 'postgres://env_user:env_pass@localhost/envdb';

      const res = resolveCredentials({});
      expect(res.dbUrl).toBe('postgres://env_user:env_pass@localhost/envdb');
      expect(res.source.dbUrl).toBe('env');
    });

    it('prefers CLI API key over ENV key', () => {
      process.env.GEMINI_API_KEY = 'env-gemini-key-12345';

      const res = resolveCredentials({
        cliApiKey: 'cli-key-99999',
        cliProvider: 'google',
      });

      expect(res.apiKey).toBe('cli-key-99999');
      expect(res.source.apiKey).toBe('cli');
    });

    it('resolves GEMINI_API_KEY, OPENAI_API_KEY, and ANTHROPIC_API_KEY when available', () => {
      process.env.OPENAI_API_KEY = 'sk-openai-key-55555';
      const openAiRes = resolveCredentials({ cliProvider: 'openai' });
      expect(openAiRes.provider).toBe('openai');
      expect(openAiRes.apiKey).toBe('sk-openai-key-55555');

      process.env.ANTHROPIC_API_KEY = 'sk-ant-anthropic-key-77777';
      const anthropicRes = resolveCredentials({ cliProvider: 'anthropic' });
      expect(anthropicRes.provider).toBe('anthropic');
      expect(anthropicRes.apiKey).toBe('sk-ant-anthropic-key-77777');
    });
  });

  describe('Saved Connection History & Key Removal', () => {
    it('manages saved connections list with deduplication', async () => {
      const { addSavedConnection, getSavedConnections, removeSavedConnection } = await import(
        '../src/config/index.js'
      );

      const url1 = 'postgresql://localhost:5432/test_history_db1';
      const url2 = 'mongodb://localhost:27017/test_history_mongo';

      addSavedConnection(url1);
      addSavedConnection(url2);

      let saved = getSavedConnections();
      expect(saved).toContain(url1);
      expect(saved).toContain(url2);

      // Re-adding url1 moves it to front and deduplicates
      addSavedConnection(url1);
      saved = getSavedConnections();
      expect(saved[0]).toBe(url1);
      expect(saved.filter((u) => u === url1).length).toBe(1);

      // Remove url1
      const removed = removeSavedConnection(url1);
      expect(removed).toBe(true);
      expect(getSavedConnections()).not.toContain(url1);

      // Clean up url2
      removeSavedConnection(url2);
    });

    it('removes stored API keys properly', async () => {
      const { writeConfig, readConfig, removeApiKey } = await import(
        '../src/config/index.js'
      );

      writeConfig({ geminiApiKey: 'test-gemini-to-remove' });
      expect(readConfig().geminiApiKey).toBe('test-gemini-to-remove');

      removeApiKey('google');
      expect(readConfig().geminiApiKey).toBeUndefined();
    });

    it('correctly retrieves stored API keys for each provider via getStoredApiKeyForProvider', async () => {
      const { writeConfig, getStoredApiKeyForProvider, removeApiKey } = await import(
        '../src/config/index.js'
      );

      writeConfig({
        geminiApiKey: 'gemini-key-123',
        openaiApiKey: 'openai-key-456',
        anthropicApiKey: 'anthropic-key-789',
      });

      expect(getStoredApiKeyForProvider('google')).toBe('gemini-key-123');
      expect(getStoredApiKeyForProvider('openai')).toBe('openai-key-456');
      expect(getStoredApiKeyForProvider('anthropic')).toBe('anthropic-key-789');

      removeApiKey('all');
      expect(getStoredApiKeyForProvider('google')).toBeUndefined();
      expect(getStoredApiKeyForProvider('openai')).toBeUndefined();
      expect(getStoredApiKeyForProvider('anthropic')).toBeUndefined();
    });
  });
});
