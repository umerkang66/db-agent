export type LLMProvider = 'google' | 'openai' | 'anthropic';

export interface SandalConfig {
  dbUrl?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  defaultProvider?: LLMProvider;
  defaultModel?: string;
  renderMarkdown?: boolean;
}

export type DbAgentConfig = SandalConfig;

export interface ResolvedCredentials {
  dbUrl?: string;
  apiKey?: string;
  provider: LLMProvider;
  model: string;
  source: {
    dbUrl: 'cli' | 'env' | 'config' | 'prompt' | 'none';
    apiKey: 'cli' | 'env' | 'config' | 'prompt' | 'none';
  };
}
