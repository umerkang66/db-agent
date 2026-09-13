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

/**
 * Checks if a given model is a reasoning or fixed-temperature model that
 * either rejects custom temperature (like 0) or does not support temperature at all.
 *
 * - Google: Gemini 2.5+, Gemini 3+, and thinking models only support default (1).
 * - OpenAI: o-series (o1, o3, o4) and reasoning models reject the temperature parameter.
 * - Anthropic: Claude thinking models reject temperature != 1.
 */
export function isReasoningOrFixedTempModel(provider: LLMProvider, model: string): boolean {
  const normalized = model.toLowerCase().replace(/^models\//, '').trim();

  switch (provider) {
    case 'google':
      return (
        normalized.includes('thinking') ||
        normalized.includes('reasoning') ||
        /^gemini-([3-9]|\d{2,}|2\.[5-9])/i.test(normalized)
      );

    case 'openai':
      return (
        /^o[1-9]/i.test(normalized) ||
        normalized.includes('reasoning') ||
        normalized.includes('thinking')
      );

    case 'anthropic':
      return (
        normalized.includes('thinking') ||
        normalized.includes('reasoning')
      );

    default:
      return false;
  }
}

/**
 * Resolves the appropriate temperature for a given provider and model.
 * Returns undefined when temperature should be omitted (e.g. for reasoning models).
 */
export function resolveTemperature(
  provider: LLMProvider,
  model: string,
  requestedTemperature?: number
): number | undefined {
  if (isReasoningOrFixedTempModel(provider, model)) {
    // For reasoning/fixed-temp models, do not pass 0 or custom temperatures
    // that the provider API will reject.
    return undefined;
  }

  // For standard models, default to 0 for deterministic SQL generation
  return requestedTemperature ?? 0;
}

/**
 * Wraps model.invoke to gracefully handle and self-heal any unexpected
 * provider-level temperature rejection errors (e.g. 400 Unsupported value: 'temperature').
 */
export function attachTemperatureFallback(model: BaseChatModel): BaseChatModel {
  const originalInvoke = model.invoke.bind(model);

  model.invoke = (async (input: any, options?: any) => {
    try {
      return await originalInvoke(input, options);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const isTempError =
        errMsg.toLowerCase().includes('temperature') &&
        (errMsg.toLowerCase().includes('unsupported') ||
          errMsg.toLowerCase().includes('does not support') ||
          errMsg.toLowerCase().includes('not support'));

      if (isTempError) {
        // Strip temperature from the model instance
        (model as any).temperature = undefined;
        if ((model as any).client?.generationConfig) {
          delete (model as any).client.generationConfig.temperature;
        }
        // Retry invocation without temperature
        return await originalInvoke(input, options);
      }
      throw err;
    }
  }) as any;

  return model;
}

export function createChatModel(options: CreateChatModelOptions): BaseChatModel {
  const { provider, model, apiKey, temperature: requestedTemp } = options;
  const temperature = resolveTemperature(provider, model, requestedTemp);

  let chatModel: BaseChatModel;

  switch (provider) {
    case 'google': {
      const config: any = {
        model,
        apiKey,
        maxRetries: 2,
      };
      if (temperature !== undefined) {
        config.temperature = temperature;
      }
      chatModel = new ChatGoogleGenerativeAI(config);
      break;
    }

    case 'openai': {
      const config: any = {
        modelName: model,
        apiKey,
        maxRetries: 2,
      };
      if (temperature !== undefined) {
        config.temperature = temperature;
      }
      chatModel = new ChatOpenAI(config);
      break;
    }

    case 'anthropic': {
      const config: any = {
        modelName: model,
        anthropicApiKey: apiKey,
        maxRetries: 2,
      };
      if (temperature !== undefined) {
        config.temperature = temperature;
      }
      chatModel = new ChatAnthropic(config);
      break;
    }

    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }

  return attachTemperatureFallback(chatModel);
}
