import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { LLMProvider } from '../config/types.js';

export interface CreateChatModelOptions {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  temperature?: number;
}

export function createChatModel(options: CreateChatModelOptions): BaseChatModel {
  const { provider, model, apiKey, temperature = 0 } = options;

  switch (provider) {
    case 'google':
      return new ChatGoogleGenerativeAI({
        model,
        apiKey,
        temperature,
        maxRetries: 2,
      });

    case 'openai':
      return new ChatOpenAI({
        modelName: model,
        apiKey,
        temperature,
        maxRetries: 2,
      });

    case 'anthropic':
      return new ChatAnthropic({
        modelName: model,
        anthropicApiKey: apiKey,
        temperature,
        maxRetries: 2,
      });

    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}
