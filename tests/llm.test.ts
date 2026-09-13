import { describe, it, expect, vi } from 'vitest';
import {
  isReasoningOrFixedTempModel,
  resolveTemperature,
  createChatModel,
  attachTemperatureFallback,
} from '../src/agent/llm.js';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessage } from '@langchain/core/messages';

describe('LLM Temperature & Reasoning Model Handling', () => {
  describe('isReasoningOrFixedTempModel', () => {
    it('identifies Google Gemini 3.x and 2.5+ models as fixed-temperature', () => {
      expect(isReasoningOrFixedTempModel('google', 'gemini-3.8-flash')).toBe(true);
      expect(isReasoningOrFixedTempModel('google', 'gemini-3.7-flash')).toBe(true);
      expect(isReasoningOrFixedTempModel('google', 'gemini-3.1-pro-preview')).toBe(true);
      expect(isReasoningOrFixedTempModel('google', 'gemini-2.5-flash')).toBe(true);
      expect(isReasoningOrFixedTempModel('google', 'gemini-2.5-pro')).toBe(true);
      expect(isReasoningOrFixedTempModel('google', 'gemini-2.5-flash-lite')).toBe(true);
      expect(isReasoningOrFixedTempModel('google', 'models/gemini-3.8-flash')).toBe(true);
    });

    it('identifies thinking models as fixed-temperature across providers', () => {
      expect(isReasoningOrFixedTempModel('google', 'gemini-2.0-flash-thinking-exp')).toBe(true);
      expect(isReasoningOrFixedTempModel('openai', 'gpt-5-thinking')).toBe(true);
      expect(isReasoningOrFixedTempModel('anthropic', 'claude-3-7-sonnet-thinking')).toBe(true);
    });

    it('identifies OpenAI o-series as reasoning models', () => {
      expect(isReasoningOrFixedTempModel('openai', 'o1')).toBe(true);
      expect(isReasoningOrFixedTempModel('openai', 'o1-mini')).toBe(true);
      expect(isReasoningOrFixedTempModel('openai', 'o3')).toBe(true);
      expect(isReasoningOrFixedTempModel('openai', 'o3-mini')).toBe(true);
      expect(isReasoningOrFixedTempModel('openai', 'o4-mini')).toBe(true);
    });

    it('returns false for standard models that support custom temperature', () => {
      expect(isReasoningOrFixedTempModel('google', 'gemini-2.0-flash')).toBe(false);
      expect(isReasoningOrFixedTempModel('openai', 'gpt-4o')).toBe(false);
      expect(isReasoningOrFixedTempModel('openai', 'gpt-4o-mini')).toBe(false);
      expect(isReasoningOrFixedTempModel('openai', 'gpt-4.1')).toBe(false);
      expect(isReasoningOrFixedTempModel('anthropic', 'claude-3-5-sonnet-latest')).toBe(false);
    });
  });

  describe('resolveTemperature', () => {
    it('returns undefined for reasoning/fixed-temp models to prevent 400 errors', () => {
      expect(resolveTemperature('google', 'gemini-3.8-flash')).toBeUndefined();
      expect(resolveTemperature('google', 'gemini-3.8-flash', 0)).toBeUndefined();
      expect(resolveTemperature('openai', 'o3-mini')).toBeUndefined();
      expect(resolveTemperature('openai', 'o3-mini', 0)).toBeUndefined();
    });

    it('defaults to 0 for standard models to ensure deterministic output', () => {
      expect(resolveTemperature('google', 'gemini-2.0-flash')).toBe(0);
      expect(resolveTemperature('openai', 'gpt-4o')).toBe(0);
      expect(resolveTemperature('anthropic', 'claude-3-5-sonnet-latest')).toBe(0);
    });

    it('preserves explicitly provided temperature for standard models', () => {
      expect(resolveTemperature('openai', 'gpt-4o', 0.7)).toBe(0.7);
      expect(resolveTemperature('google', 'gemini-2.0-flash', 0.5)).toBe(0.5);
    });
  });

  describe('createChatModel instantiation', () => {
    it('omits temperature from ChatGoogleGenerativeAI for gemini-3.8-flash', () => {
      const model = createChatModel({
        provider: 'google',
        model: 'gemini-3.8-flash',
        apiKey: 'fake-key',
      }) as ChatGoogleGenerativeAI;

      expect(model.temperature).toBeUndefined();
      expect((model as any).client?.generationConfig?.temperature).toBeUndefined();
    });

    it('sets temperature 0 for standard models like gemini-2.0-flash', () => {
      const model = createChatModel({
        provider: 'google',
        model: 'gemini-2.0-flash',
        apiKey: 'fake-key',
      }) as ChatGoogleGenerativeAI;

      expect(model.temperature).toBe(0);
      expect((model as any).client?.generationConfig?.temperature).toBe(0);
    });

    it('omits temperature from ChatOpenAI for o3-mini', () => {
      const model = createChatModel({
        provider: 'openai',
        model: 'o3-mini',
        apiKey: 'fake-key',
      }) as ChatOpenAI;

      expect(model.temperature).toBeUndefined();
    });

    it('sets temperature 0 for standard models like gpt-4o', () => {
      const model = createChatModel({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'fake-key',
      }) as ChatOpenAI;

      expect(model.temperature).toBe(0);
    });

    it('catches runtime temperature errors and transparently retries without temperature', async () => {
      let invokedTimes = 0;
      const mockResult = new AIMessage({ content: '{"sql": "SELECT 1;"}' });

      const fakeModel: any = {
        temperature: 0,
        client: {
          generationConfig: {
            temperature: 0,
          },
        },
        invoke: vi.fn().mockImplementation(async () => {
          invokedTimes++;
          if (invokedTimes === 1) {
            throw new Error(
              "400 Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported."
            );
          }
          return mockResult;
        }),
      };

      const wrapped = attachTemperatureFallback(fakeModel as any);
      const result = await wrapped.invoke([]);

      expect(invokedTimes).toBe(2);
      expect((result as any).content).toBe('{"sql": "SELECT 1;"}');
      expect((fakeModel as any).temperature).toBeUndefined();
      expect((fakeModel as any).client.generationConfig.temperature).toBeUndefined();
    });
  });
});
