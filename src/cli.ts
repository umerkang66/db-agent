#!/usr/bin/env node
import fs from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { input, select, confirm } from '@inquirer/prompts';
import {
  readConfig,
  writeConfig,
  resolveCredentials,
  maskUrl,
  maskApiKey,
  getConfigFilePath,
  getDefaultModelForProvider,
  removeApiKey,
  getSavedConnections,
  addSavedConnection,
  removeSavedConnection,
} from './config/index.js';
import { LLMProvider } from './config/types.js';
import { createDatabaseAdapter, detectDatabaseType } from './db/connection.js';
import { createChatModel } from './agent/llm.js';
import { ReplSession } from './repl.js';
import { renderMarkdown } from './markdown.js';

const program = new Command();

program
  .name('sandal-db')
  .description('SANDAL - Safe Agentic Natural-language Database Access Layer')
  .version('1.0.0')
  .argument('[dbUrl]', 'Database connection URL (PostgreSQL or MongoDB)')
  .option(
    '-p, --provider <provider>',
    'LLM provider: google | openai | anthropic',
  )
  .option(
    '-m, --model <model>',
    'LLM model name (e.g. gemini-2.5-flash, gpt-4o, claude-3-5-sonnet-latest)',
  )
  .option('-k, --key <key>', 'API key for the chosen LLM provider')
  .option(
    '--strict',
    'Strict safety mode: hard-blocks full database wipes (default: true)',
    true,
  )
  .option('--no-strict', 'Disable strict safety mode')
  .option(
    '--allow-full-wipe',
    'Explicitly allow full database / all-table wipe queries with confirmation',
    false,
  )
  .option(
    '--threshold <number>',
    'Row count threshold for classifying updates as dangerous',
    '50',
  )
  .option(
    '--markdown',
    'Render LLM answers formatted as terminal markdown (default: true)',
    true,
  )
  .option('--no-markdown', 'Disable terminal markdown rendering')
  .action(async (cliDbUrl, options) => {
    try {
      await runCli({
        cliDbUrl,
        cliProvider: options.provider,
        cliModel: options.model,
        cliApiKey: options.key,
        strictMode: options.strict !== false,
        allowFullWipe: Boolean(options.allowFullWipe),
        rowThreshold: parseInt(options.threshold, 10) || 50,
        renderMarkdown: options.markdown !== false,
      });
    } catch (err: any) {
      console.error(chalk.red(`\nError: ${err.message}`));
      process.exit(1);
    }
  });

// Config Subcommand
const configCmd = program
  .command('config')
  .description(
    'Manage stored database credentials and API keys in ~/.sandal/config.json',
  )
  .option('--set-db <url>', 'Set default database connection URL')
  .option('--set-key <key>', 'Set API key for the default provider')
  .option('--set-gemini <key>', 'Set Google Gemini API key')
  .option('--set-openai <key>', 'Set OpenAI API key')
  .option('--set-anthropic <key>', 'Set Anthropic API key')
  .option(
    '--set-provider <provider>',
    'Set default LLM provider (google | openai | anthropic)',
  )
  .option('--set-model <model>', 'Set default model name')
  .option(
    '--set-markdown <boolean>',
    'Enable or disable default terminal markdown rendering (true | false)',
  )
  .option(
    '--remove-key [provider]',
    'Remove stored API key for a provider (google | openai | anthropic | all)',
  )
  .option(
    '--connections',
    'List all saved database connections',
  )
  .option(
    '--remove-connection <target>',
    'Remove a saved database connection by URL or index',
  )
  .option(
    '--show',
    'Display current stored configuration (with masked secrets)',
  )
  .option('--path', 'Print the path to the configuration file')
  .action(opts => {
    if (opts.path) {
      console.log(getConfigFilePath());
      return;
    }

    if (opts.connections) {
      const list = getSavedConnections();
      if (list.length === 0) {
        console.log(chalk.yellow('\nNo saved database connections found.\n'));
      } else {
        console.log(chalk.bold.cyan('\nSaved Database Connections:'));
        list.forEach((url, i) => {
          console.log(`  [${i + 1}] ${maskUrl(url)}`);
        });
        console.log('');
      }
      return;
    }

    if (opts.removeConnection) {
      const removed = removeSavedConnection(opts.removeConnection);
      if (removed) {
        console.log(chalk.green(`Removed connection from saved history.`));
      } else {
        console.log(chalk.red(`Connection "${opts.removeConnection}" not found in history.`));
      }
      return;
    }

    if (opts.removeKey !== undefined) {
      const prov = typeof opts.removeKey === 'string' && opts.removeKey.trim()
        ? opts.removeKey.toLowerCase()
        : 'all';
      removeApiKey(prov as any);
      console.log(chalk.green(`Removed API key for "${prov}" from ~/.sandal/config.json.`));
      return;
    }

    if (opts.show) {
      const cfg = readConfig();
      const saved = getSavedConnections();
      console.log(
        chalk.bold.cyan('\nSaved Configuration (~/.sandal/config.json):'),
      );
      console.log(
        `  Database URL:       ${cfg.dbUrl ? chalk.green(maskUrl(cfg.dbUrl)) : chalk.gray('Not set')}`,
      );
      console.log(
        `  Default Provider:   ${cfg.defaultProvider ? chalk.blue(cfg.defaultProvider) : chalk.gray('Not set (defaults to google)')}`,
      );
      console.log(
        `  Default Model:      ${cfg.defaultModel ? chalk.white(cfg.defaultModel) : chalk.gray('Default for provider')}`,
      );
      console.log(
        `  Markdown Rendering: ${cfg.renderMarkdown !== false ? chalk.green('enabled') : chalk.yellow('disabled')}`,
      );
      console.log(
        `  Saved Connections:  ${saved.length > 0 ? chalk.cyan(`${saved.length} connection(s)`) : chalk.gray('None')}`,
      );
      console.log(
        `  Gemini Key:         ${cfg.geminiApiKey ? chalk.yellow(maskApiKey(cfg.geminiApiKey)) : chalk.gray('Not set')}`,
      );
      console.log(
        `  OpenAI Key:         ${cfg.openaiApiKey ? chalk.yellow(maskApiKey(cfg.openaiApiKey)) : chalk.gray('Not set')}`,
      );
      console.log(
        `  Anthropic Key:      ${cfg.anthropicApiKey ? chalk.yellow(maskApiKey(cfg.anthropicApiKey)) : chalk.gray('Not set')}\n`,
      );
      return;
    }

    const updates: Record<string, any> = {};
    if (opts.setDb) {
      detectDatabaseType(opts.setDb); // validate scheme
      updates.dbUrl = opts.setDb;
      addSavedConnection(opts.setDb);
      console.log(
        chalk.green(`Updated default database URL: ${maskUrl(opts.setDb)}`),
      );
    }
    if (opts.setProvider) {
      const p = opts.setProvider.toLowerCase();
      if (!['google', 'openai', 'anthropic'].includes(p)) {
        console.error(
          chalk.red('Invalid provider. Expected google, openai, or anthropic.'),
        );
        process.exit(1);
      }
      updates.defaultProvider = p;
      console.log(chalk.green(`Updated default provider: ${p}`));
    }
    if (opts.setModel) {
      updates.defaultModel = opts.setModel;
      console.log(chalk.green(`Updated default model: ${opts.setModel}`));
    }
    if (opts.setMarkdown !== undefined) {
      const val =
        opts.setMarkdown.toLowerCase() === 'true' ||
        opts.setMarkdown === '1' ||
        opts.setMarkdown === 'yes';
      updates.renderMarkdown = val;
      console.log(
        chalk.green(
          `Updated default markdown rendering: ${val ? 'enabled' : 'disabled'}.`,
        ),
      );
    }
    if (opts.setGemini) {
      updates.geminiApiKey = opts.setGemini;
      console.log(chalk.green('Updated Gemini API key.'));
    }
    if (opts.setOpenai) {
      updates.openaiApiKey = opts.setOpenai;
      console.log(chalk.green('Updated OpenAI API key.'));
    }
    if (opts.setAnthropic) {
      updates.anthropicApiKey = opts.setAnthropic;
      console.log(chalk.green('Updated Anthropic API key.'));
    }
    if (opts.setKey) {
      const current = readConfig();
      const prov = (updates.defaultProvider ||
        current.defaultProvider ||
        'google') as LLMProvider;
      if (prov === 'google') updates.geminiApiKey = opts.setKey;
      else if (prov === 'openai') updates.openaiApiKey = opts.setKey;
      else if (prov === 'anthropic') updates.anthropicApiKey = opts.setKey;
      console.log(chalk.green(`Updated API key for provider "${prov}".`));
    }

    if (Object.keys(updates).length > 0) {
      writeConfig(updates);
      console.log(chalk.gray(`Saved to ${getConfigFilePath()}`));
    } else {
      configCmd.help();
    }
  });

// Markdown Subcommand
program
  .command('markdown [fileOrText]')
  .alias('md')
  .description('Render markdown text or a markdown file directly in the terminal')
  .option('-w, --width <width>', 'Wrap width in columns')
  .option('--no-prefix', 'Hide heading section prefixes')
  .action(async (fileOrText, opts) => {
    let content = fileOrText;

    if (!content) {
      if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(Buffer.from(chunk));
        }
        content = Buffer.concat(chunks).toString('utf-8');
      } else {
        console.log(
          chalk.yellow(
            '\nUsage: sandal md <file | text> or pipe markdown to sandal md',
          ),
        );
        console.log(chalk.gray('Example: sandal md README.md'));
        console.log(chalk.gray('Example: sandal md "# Hello World"'));
        console.log(chalk.gray('Example: cat notes.md | sandal md\n'));
        return;
      }
    } else {
      try {
        if (fs.existsSync(content) && fs.statSync(content).isFile()) {
          content = fs.readFileSync(content, 'utf-8');
        }
      } catch {
        // Not a readable file path, treat as inline markdown text
      }
    }

    const width = opts.width ? parseInt(opts.width, 10) : undefined;
    const rendered = renderMarkdown(content, {
      width,
      showSectionPrefix: opts.prefix !== false,
    });
    console.log('\n' + rendered + '\n');
  });

async function runCli(opts: {
  cliDbUrl?: string;
  cliProvider?: string;
  cliModel?: string;
  cliApiKey?: string;
  strictMode: boolean;
  allowFullWipe: boolean;
  rowThreshold: number;
  renderMarkdown?: boolean;
}) {
  const config = readConfig();
  const shouldRenderMarkdown =
    opts.renderMarkdown !== undefined
      ? opts.renderMarkdown
      : config.renderMarkdown !== false;

  let resolved = resolveCredentials({
    cliDbUrl: opts.cliDbUrl,
    cliProvider: opts.cliProvider,
    cliModel: opts.cliModel,
    cliApiKey: opts.cliApiKey,
  });

  // 1. Prompt for DB URL if not provided
  let dbUrl = resolved.dbUrl;
  if (!dbUrl) {
    console.log(
      chalk.yellow(
        '\nNo database connection URL found in CLI flags, environment, or config.',
      ),
    );
    dbUrl = await input({
      message: 'Enter your database URL (postgres://... or mongodb://...):',
      validate: val => {
        try {
          detectDatabaseType(val);
          return true;
        } catch (e: any) {
          return e.message;
        }
      },
    });

    const saveDb = await confirm({
      message:
        'Save this database URL to ~/.sandal/config.json for future runs?',
      default: true,
    });
    if (saveDb) {
      writeConfig({ dbUrl });
    }
  } else if (opts.cliDbUrl && resolved.source.dbUrl === 'cli') {
    // If passed explicitly via CLI and not yet in config, save if new
    const currentCfg = readConfig();
    if (currentCfg.dbUrl !== opts.cliDbUrl) {
      writeConfig({ dbUrl: opts.cliDbUrl });
    }
  }

  // 2. Resolve or prompt for Provider & API Key
  let provider = resolved.provider;
  let apiKey = resolved.apiKey;

  if (!apiKey) {
    console.log(chalk.yellow('\nNo API key found in environment or config.'));
    provider = await select<LLMProvider>({
      message: 'Select your LLM provider:',
      choices: [
        { name: 'Google Gemini (GEMINI_API_KEY)', value: 'google' },
        { name: 'OpenAI (OPENAI_API_KEY)', value: 'openai' },
        { name: 'Anthropic (ANTHROPIC_API_KEY)', value: 'anthropic' },
      ],
    });

    apiKey = await input({
      message: `Enter your ${provider.toUpperCase()} API key:`,
      validate: val =>
        val.trim().length > 0 ? true : 'API key cannot be empty.',
    });

    const saveKey = await confirm({
      message: 'Save this API key to ~/.sandal/config.json?',
      default: true,
    });

    if (saveKey) {
      if (provider === 'google')
        writeConfig({ geminiApiKey: apiKey, defaultProvider: 'google' });
      else if (provider === 'openai')
        writeConfig({ openaiApiKey: apiKey, defaultProvider: 'openai' });
      else if (provider === 'anthropic')
        writeConfig({ anthropicApiKey: apiKey, defaultProvider: 'anthropic' });
    }
  }

  const modelName =
    opts.cliModel || resolved.model || getDefaultModelForProvider(provider);

  // 3. Connect to DB
  const dbSpinner = ora(
    `Connecting to database (${maskUrl(dbUrl)})...`,
  ).start();
  const adapter = createDatabaseAdapter(dbUrl);
  try {
    await adapter.connect();
    dbSpinner.succeed(
      chalk.green(
        `Connected to ${adapter.type.toUpperCase()} database: ${adapter.databaseName}`,
      ),
    );
    addSavedConnection(dbUrl);
  } catch (err: any) {
    dbSpinner.fail(chalk.red(`Failed to connect to database: ${err.message}`));
    process.exit(1);
  }

  // 4. Create LLM
  const model = createChatModel({
    provider,
    model: modelName,
    apiKey,
  });

  // 5. Start REPL
  const repl = new ReplSession({
    adapter,
    model,
    provider,
    modelName,
    apiKey,
    strictMode: opts.strictMode,
    allowFullWipe: opts.allowFullWipe,
    rowThreshold: opts.rowThreshold,
    renderMarkdown: shouldRenderMarkdown,
  });

  await repl.start();
}

program.parse(process.argv);
