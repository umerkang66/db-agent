import chalk from 'chalk';
import Table from 'cli-table3';
import { select, input } from '@inquirer/prompts';
import { LLMProvider } from './types.js';

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextWindow: string;
  badge?: string;
  recommended?: boolean;
}

export const PROVIDER_MODELS: Record<LLMProvider, ModelInfo[]> = {
  google: [
    {
      id: 'gemini-3.8-flash',
      name: 'Gemini 3.8 Flash',
      description: 'Latest Gemini 3 Flash. High speed, low latency, advanced reasoning & multimodal',
      contextWindow: '1M',
      badge: 'Latest Flagship',
      recommended: true,
    },
    {
      id: 'gemini-3.7-flash',
      name: 'Gemini 3.7 Flash',
      description: 'Hybrid reasoning model with dynamic thinking tokens',
      contextWindow: '1M',
      badge: 'Hybrid Reasoning',
    },
    {
      id: 'gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro',
      description: 'Frontier reasoning for complex schemas, agentic planning & SQL logic',
      contextWindow: '2M',
      badge: 'Frontier Pro',
    },
    {
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      description: 'Production workhorse, high throughput, balanced performance',
      contextWindow: '1M',
      badge: 'Production Stable',
    },
    {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      description: 'Deep reasoning and complex SQL query generation across massive schemas',
      contextWindow: '2M',
    },
    {
      id: 'gemini-3.5-flash-lite',
      name: 'Gemini 3.5 Flash-Lite',
      description: 'Ultra-fast lightweight model for budget-sensitive high-QPS tasks',
      contextWindow: '1M',
      badge: 'Fast & Budget',
    },
    {
      id: 'gemini-2.5-flash-lite',
      name: 'Gemini 2.5 Flash-Lite',
      description: 'Fast and economical multimodal model',
      contextWindow: '1M',
    },
    {
      id: 'gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      description: 'Stable legacy 2.0 Flash model',
      contextWindow: '1M',
    },
  ],

  openai: [
    {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      description: 'Flagship frontier model for complex professional work, coding & database tasks',
      contextWindow: '1M+',
      badge: 'Latest Flagship',
      recommended: true,
    },
    {
      id: 'gpt-6-astra',
      name: 'GPT-6 Astra',
      description: 'OpenAI most capable model, built for hardest end-to-end coding & reasoning',
      contextWindow: '1M+',
      badge: 'Frontier Peak',
    },
    {
      id: 'gpt-5.6-terra',
      name: 'GPT-5.6 Terra',
      description: 'Balanced intelligence and cost for general database exploration',
      contextWindow: '1M+',
      badge: 'Balanced',
    },
    {
      id: 'gpt-5.6-luna',
      name: 'GPT-5.6 Luna',
      description: 'Optimized for high-volume, cost-sensitive production workloads',
      contextWindow: '1M+',
      badge: 'Economical',
    },
    {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      description: 'High-performance model for coding and analytical workflows',
      contextWindow: '272K+',
    },
    {
      id: 'gpt-5.4-mini',
      name: 'GPT-5.4 Mini',
      description: 'Strongest mini model for coding, tool use, and subagents',
      contextWindow: '128K',
      badge: 'Fast & Smart',
    },
    {
      id: 'o4-mini',
      name: 'o4-mini',
      description: 'Next-gen fast, cost-efficient reasoning model with thinking capabilities',
      contextWindow: '200K',
      badge: 'Fast Reasoning',
    },
    {
      id: 'o3-mini',
      name: 'o3-mini',
      description: 'Compact reasoning model with configurable thinking effort',
      contextWindow: '200K',
    },
    {
      id: 'o3',
      name: 'o3',
      description: 'High-compute reasoning model for complex analytics and tricky queries',
      contextWindow: '200K',
      badge: 'Deep Reasoning',
    },
    {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      description: 'Smartest non-reasoning direct chat & generation model',
      contextWindow: '128K',
    },
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      description: 'Versatile multimodal workhorse for general tasks',
      contextWindow: '128K',
    },
    {
      id: 'gpt-4o-mini',
      name: 'GPT-4o Mini',
      description: 'Affordable small model for fast queries and schema lookups',
      contextWindow: '128K',
    },
  ],

  anthropic: [
    {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      description: 'Optimal balance of speed, intelligence & 1M token context window',
      contextWindow: '1M',
      badge: 'Latest Flagship',
      recommended: true,
    },
    {
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      description: 'Complex agentic coding, database refactoring & enterprise reasoning',
      contextWindow: '1M',
      badge: 'Deep Intelligence',
    },
    {
      id: 'claude-fable-5-1',
      name: 'Claude Fable 5.1',
      description: 'Demanding reasoning and long-horizon autonomous agentic work',
      contextWindow: '1M',
      badge: 'Long Horizon',
    },
    {
      id: 'claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
      description: 'Fastest Claude model with near-frontier intelligence for rapid responses',
      contextWindow: '200K',
      badge: 'Ultra Fast',
    },
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      description: 'Pinned dateless enterprise release for production stability',
      contextWindow: '500K',
    },
    {
      id: 'claude-3-7-sonnet-latest',
      name: 'Claude 3.7 Sonnet',
      description: 'Hybrid reasoning model with adjustable thinking budgets',
      contextWindow: '200K',
      badge: 'Hybrid Reasoning',
    },
    {
      id: 'claude-3-5-sonnet-latest',
      name: 'Claude 3.5 Sonnet',
      description: 'Industry benchmark for coding and function calling',
      contextWindow: '200K',
    },
    {
      id: 'claude-3-5-haiku-latest',
      name: 'Claude 3.5 Haiku',
      description: 'Ultra-fast lightweight tool use model',
      contextWindow: '200K',
    },
  ],
};

/**
 * Returns the list of available models for a given provider.
 */
export function getModelsForProvider(provider: LLMProvider): ModelInfo[] {
  return PROVIDER_MODELS[provider] || [];
}

/**
 * Interactively prompts the user to choose a model for the given provider.
 */
export function getModelChoices(provider: LLMProvider, currentModel?: string) {
  const models = getModelsForProvider(provider);
  const choices = models.map(m => {
    const isCurrent = m.id === currentModel;
    const badgeText = m.badge ? chalk.dim(` [${m.badge}]`) : '';
    const recText = m.recommended ? chalk.green(' ★ Recommended') : '';
    const currentText = isCurrent ? chalk.cyan(' (Current)') : '';

    return {
      name: `${chalk.bold(m.id)}${recText}${badgeText}${currentText}`,
      value: m.id,
      description: `${m.name} (Context: ${m.contextWindow}) — ${m.description}`,
    };
  });

  choices.push({
    name: chalk.yellow('Custom model (type manually)...'),
    value: '__custom__',
    description: 'Specify an unlisted or experimental model identifier',
  });

  return choices;
}

/**
 * Prompt user with Inquirer select to pick a model from the curated list.
 */
export async function promptModelSelection(
  provider: LLMProvider,
  currentModel?: string
): Promise<string> {
  const choices = getModelChoices(provider, currentModel);

  const selected = await select<string>({
    message: `Select LLM model for ${chalk.bold.cyan(provider.toUpperCase())}:`,
    choices,
    pageSize: 10,
  });

  if (selected === '__custom__') {
    const custom = await input({
      message: 'Enter custom model name:',
      validate: val => (val.trim().length > 0 ? true : 'Model name cannot be empty.'),
    });
    return custom.trim();
  }

  return selected;
}

/**
 * Formats a terminal-friendly table of available models for display.
 */
export function renderModelsTable(provider?: LLMProvider): string {
  const providers: LLMProvider[] = provider
    ? [provider]
    : ['google', 'openai', 'anthropic'];

  const lines: string[] = [];

  for (const prov of providers) {
    const models = getModelsForProvider(prov);
    const table = new Table({
      head: [
        chalk.bold.cyan('Model ID'),
        chalk.bold.cyan('Display Name'),
        chalk.bold.cyan('Context'),
        chalk.bold.cyan('Category / Badge'),
        chalk.bold.cyan('Description'),
      ],
      colWidths: [26, 20, 10, 20, 42],
      wordWrap: true,
    });

    for (const m of models) {
      const idCol = m.recommended
        ? chalk.green.bold(`★ ${m.id}`)
        : chalk.white.bold(m.id);
      const badgeCol = m.badge ? chalk.yellow(m.badge) : chalk.gray('-');
      table.push([idCol, m.name, m.contextWindow, badgeCol, m.description]);
    }

    lines.push(
      chalk.bold.magenta(`\n=== Available Public Models for ${prov.toUpperCase()} ===\n`)
    );
    lines.push(table.toString());
  }

  return lines.join('\n');
}
