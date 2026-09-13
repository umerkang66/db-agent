import { describe, it, expect } from 'vitest';
import {
  getModelsForProvider,
  getModelChoices,
  renderModelsTable,
  PROVIDER_MODELS,
} from '../src/config/models.js';

describe('LLM Models Catalog & Selection', () => {
  it('defines models for all three supported providers', () => {
    expect(PROVIDER_MODELS.google.length).toBeGreaterThan(0);
    expect(PROVIDER_MODELS.openai.length).toBeGreaterThan(0);
    expect(PROVIDER_MODELS.anthropic.length).toBeGreaterThan(0);
  });

  it('provides complete metadata for every model entry', () => {
    const providers = ['google', 'openai', 'anthropic'] as const;
    for (const prov of providers) {
      const models = getModelsForProvider(prov);
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(m.id).toBeTruthy();
        expect(m.name).toBeTruthy();
        expect(m.description).toBeTruthy();
        expect(m.contextWindow).toBeTruthy();
      }
    }
  });

  it('builds interactive choices including a custom model option', () => {
    const choices = getModelChoices('google', 'gemini-3.8-flash');
    expect(choices.length).toBeGreaterThan(1);
    const customChoice = choices.find(c => c.value === '__custom__');
    expect(customChoice).toBeDefined();

    const currentChoice = choices.find(c => c.value === 'gemini-3.8-flash');
    expect(currentChoice?.name).toContain('(Current)');
  });

  it('renders a formatted ASCII table for single or all providers without error', () => {
    const singleTable = renderModelsTable('anthropic');
    expect(singleTable).toContain('claude-sonnet-5');
    expect(singleTable).toContain('ANTHROPIC');

    const allTables = renderModelsTable();
    expect(allTables).toContain('GOOGLE');
    expect(allTables).toContain('OPENAI');
    expect(allTables).toContain('ANTHROPIC');
  });
});
