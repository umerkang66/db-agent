export type LLMProvider = 'google' | 'openai' | 'anthropic';

export interface DbAgentConfig {
  dbUrl?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  defaultProvider?: LLMProvider;
  defaultModel?: string;
}

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
