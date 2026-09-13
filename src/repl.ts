import readline from 'node:readline';
import fs from 'node:fs';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import Table from 'cli-table3';
import { DatabaseAdapter } from './db/adapter.js';
import { createDatabaseAdapter, detectDatabaseType } from './db/connection.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createDatabaseAgent } from './agent/graph.js';
import { createChatModel } from './agent/llm.js';
import { classifyIntent, REFUSAL_MESSAGE } from './agent/guardrails.js';
import { ClassifierOptions } from './safety/classifier.js';
import { requestUserConfirmation } from './safety/confirm.js';
import { formatSchemaForPrompt } from './agent/prompts.js';
import { renderMarkdown } from './markdown.js';
import {
  writeConfig,
  maskUrl,
  maskApiKey,
  removeApiKey,
  getSavedConnections,
  addSavedConnection,
  resolveCredentials,
  getDefaultModelForProvider,
  getModelsForProvider,
  getStoredApiKeyForProvider,
} from './config/index.js';
import { LLMProvider } from './config/types.js';
import { ChatMemoryManager } from './agent/memory.js';

export interface ReplOptions {
  adapter: DatabaseAdapter;
  model: BaseChatModel;
  provider: string;
  modelName: string;
  apiKey?: string;
  strictMode: boolean;
  allowFullWipe: boolean;
  rowThreshold?: number;
  renderMarkdown?: boolean;
}

export class ReplSession {
  private adapter: DatabaseAdapter;
  private model: BaseChatModel;
  private provider: string;
  private modelName: string;
  private apiKey?: string;
  private strictMode: boolean;
  private allowFullWipe: boolean;
  private rowThreshold: number;
  private renderMarkdown: boolean;
  private isRunning = true;
  private sessionId: string;
  private agent!: ReturnType<typeof createDatabaseAgent>;
  private memoryManager: ChatMemoryManager;
  private classifierOptions: ClassifierOptions;
  private rl?: readline.Interface;
  private currentSpinner?: ReturnType<typeof ora>;

  constructor(options: ReplOptions) {
    this.adapter = options.adapter;
    this.model = options.model;
    this.provider = options.provider;
    this.modelName = options.modelName;
    this.apiKey = options.apiKey;
    this.strictMode = options.strictMode;
    this.allowFullWipe = options.allowFullWipe;
    this.rowThreshold = options.rowThreshold ?? 50;
    this.renderMarkdown = options.renderMarkdown ?? true;

    this.classifierOptions = {
      strictMode: this.strictMode,
      allowFullWipe: this.allowFullWipe,
      rowThresholdForDangerousUpdate: this.rowThreshold,
    };

    this.initAgent();

    this.memoryManager = new ChatMemoryManager();
    const initialSession = this.memoryManager.createSession('New Chat', this.adapter.connectionUrl);
    this.sessionId = initialSession.id;

    // Automatically save current connection to history
    if (this.adapter.connectionUrl) {
      addSavedConnection(this.adapter.connectionUrl);
    }
  }

  private initAgent(): void {
    this.agent = createDatabaseAgent({
      adapter: this.adapter,
      model: this.model,
      classifierOptions: this.classifierOptions,
      confirmFn: async (query, safety, affectedRows) => {
        if (this.currentSpinner && this.currentSpinner.isSpinning) {
          this.currentSpinner.stop();
        }
        const confirmResult = await requestUserConfirmation(
          query,
          safety,
          affectedRows,
          this.askQuestion.bind(this)
        );
        if (confirmResult.confirmed && this.currentSpinner) {
          this.currentSpinner.text = chalk.cyan('Executing query and analyzing...');
          this.currentSpinner.start();
        }
        return confirmResult;
      },
    });
  }

  private askQuestion(query: string): Promise<string> {
    process.stdin.resume();
    if (!this.rl || (this.rl as any).closed) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
    }
    return new Promise((resolve) => this.rl!.question(query, resolve));
  }

  private getPromptText(): string {
    return chalk.cyan(`sandal [${this.adapter.type}]> `);
  }

  public async start(): Promise<void> {
    this.setupSignalHandlers();
    this.printWelcomeBanner();

    process.stdin.resume();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const askQuestion = this.askQuestion.bind(this);

    while (this.isRunning) {
      process.stdin.resume();
      const input = await askQuestion(this.getPromptText());
      const trimmed = input.trim();

      if (!trimmed) continue;

      if (['exit', 'quit', '.exit', '.quit'].includes(trimmed.toLowerCase())) {
        break;
      }

      if (trimmed === '.clear') {
        console.clear();
        continue;
      }

      if (trimmed === '.help') {
        this.printHelp();
        continue;
      }

      if (trimmed === '.tables' || trimmed === '.collections') {
        await this.handleListEntities();
        continue;
      }

      if (trimmed.startsWith('.schema')) {
        const entityName = trimmed.replace(/^\.schema\s*/, '').trim();
        await this.handleShowSchema(entityName);
        continue;
      }

      if (trimmed === '.refresh') {
        const spinner = ora(chalk.blue('Refreshing schema cache...')).start();
        try {
          await this.adapter.inspectSchema(true);
          spinner.succeed(chalk.green('Schema refreshed successfully.'));
        } catch (err: any) {
          spinner.fail(chalk.red(`Failed to refresh schema: ${err.message}`));
        }
        continue;
      }

      if (trimmed.startsWith('.md') || trimmed.startsWith('.markdown')) {
        const entityOrText = trimmed.replace(/^\.(?:markdown|md)\s*/, '').trim();
        this.handleRenderMarkdown(entityOrText);
        continue;
      }

      // Connection switching & history
      if (
        trimmed.startsWith('.connect') ||
        trimmed.startsWith('.switch') ||
        trimmed === '.connections' ||
        trimmed === '.databases'
      ) {
        const targetUrl = trimmed.replace(/^\.(?:connect|switch)\s*/, '').trim();
        await this.handleSwitchConnection(targetUrl, askQuestion);
        continue;
      }

      // Model switching
      if (trimmed.startsWith('.model')) {
        const targetModel = trimmed.replace(/^\.model\s*/, '').trim();
        await this.handleModelCommand(targetModel, askQuestion);
        continue;
      }

      // Provider switching
      if (trimmed.startsWith('.provider')) {
        const targetProvider = trimmed.replace(/^\.provider\s*/, '').trim();
        await this.handleProviderCommand(targetProvider, askQuestion);
        continue;
      }

      // API Key inspection and removal
      if (trimmed.startsWith('.key')) {
        const keyArg = trimmed.replace(/^\.key\s*/, '').trim();
        await this.handleKeyCommand(keyArg, askQuestion);
        continue;
      }

      // Per-chat memory commands
      if (trimmed === '.chats') {
        this.handleListChats();
        continue;
      }

      if (trimmed === '.new') {
        this.handleNewChat();
        continue;
      }

      if (trimmed.startsWith('.chat')) {
        const chatArg = trimmed.replace(/^\.chat\s*/, '').trim();
        if (!chatArg || chatArg === 'new') {
          this.handleNewChat();
        } else {
          this.handleSwitchChat(chatArg);
        }
        continue;
      }

      if (trimmed === '.history') {
        this.handleShowHistory();
        continue;
      }

      if (trimmed === '.clear-chat' || trimmed === '.clear-history') {
        this.handleClearChat();
        continue;
      }

      // 1. INTENT GUARDRAILS CHECK WITH CHAT CONTEXT
      const intentSpinner = ora(chalk.blue('Analyzing intent...')).start();
      const historySummary = this.memoryManager.getRecentSummary(this.sessionId, 4);
      const intent = await classifyIntent(trimmed, this.model, historySummary);
      intentSpinner.stop();

      if (!intent.isDatabaseTask) {
        console.log(
          boxen(
            `${chalk.bold.red('🛡️ GUARDRAIL ENFORCEMENT')}\n\n${chalk.yellow(REFUSAL_MESSAGE)}\n\n${chalk.gray(
              `Reason: ${intent.reason || 'Non-database request rejected'}`
            )}`,
            {
              padding: 1,
              borderColor: 'red',
              borderStyle: 'round',
              margin: { top: 1, bottom: 1 },
            }
          )
        );
        continue;
      }

      // 2. RUN AGENT GRAPH WITH CONVERSATION MEMORY
      const agentSpinner = ora(chalk.cyan('Agent planning query...')).start();
      this.currentSpinner = agentSpinner;

      try {
        const historyMessages = this.memoryManager.toLangChainMessages(this.sessionId, 6);
        const result = await this.agent.invoke(
          {
            userInput: trimmed,
            messages: historyMessages,
          },
          {
            configurable: {
              thread_id: this.sessionId,
            },
          }
        );

        if (agentSpinner.isSpinning) {
          agentSpinner.stop();
        }

        // If query was executed and returned rows, render table
        if (result.queryResult && result.queryResult.success && result.queryResult.rows) {
          this.renderRowsTable(result.queryResult);
        }

        // Print final conclusion
        if (result.conclusion) {
          console.log('\n' + chalk.green('🤖 Answer:'));
          if (this.renderMarkdown) {
            console.log(renderMarkdown(result.conclusion) + '\n');
          } else {
            console.log(chalk.white(result.conclusion) + '\n');
          }
        }

        // Save conversation turn to persistent chat memory
        this.memoryManager.addMessage(
          this.sessionId,
          { role: 'user', content: trimmed },
          this.adapter.connectionUrl
        );

        if (result.conclusion) {
          const queryStr = result.generatedQuery?.sql || result.generatedQuery?.rawDisplay;
          this.memoryManager.addMessage(
            this.sessionId,
            {
              role: 'assistant',
              content: result.conclusion,
              query: queryStr,
              rowCount: result.queryResult?.rowCount,
            },
            this.adapter.connectionUrl
          );
        }
      } catch (err: any) {
        if (agentSpinner.isSpinning) {
          agentSpinner.fail(chalk.red(`Execution failed: ${err.message}`));
        } else {
          console.error(chalk.red(`\nExecution failed: ${err.message}\n`));
        }
      } finally {
        if (agentSpinner.isSpinning) {
          agentSpinner.stop();
        }
        this.currentSpinner = undefined;
        process.stdin.resume();
      }
    }

    if (this.rl && !(this.rl as any).closed) {
      this.rl.close();
    }
    await this.shutdown();
  }

  private async handleSwitchConnection(
    targetUrl: string,
    ask: (q: string) => Promise<string>
  ): Promise<void> {
    let urlToConnect = targetUrl;

    if (!urlToConnect) {
      const saved = getSavedConnections();
      console.log(chalk.bold.cyan('\nDatabase Connections:'));
      if (saved.length === 0) {
        console.log(chalk.gray('  (No previous connections saved)'));
      } else {
        saved.forEach((url, i) => {
          const isCurrent = url === this.adapter.connectionUrl;
          const currentTag = isCurrent ? chalk.green(' (Current)') : '';
          console.log(`  [${i + 1}] ${maskUrl(url)}${currentTag}`);
        });
      }
      console.log(chalk.gray('  [N] Enter a new connection URL'));
      console.log(chalk.gray('  [C] Cancel\n'));

      const choice = (await ask(chalk.cyan('Select a connection [number, N, C]: '))).trim();
      if (!choice || choice.toLowerCase() === 'c') {
        return;
      }

      if (choice.toLowerCase() === 'n') {
        const entered = (await ask(chalk.cyan('Enter database connection URL: '))).trim();
        if (!entered) return;
        urlToConnect = entered;
      } else {
        const num = parseInt(choice, 10);
        if (!isNaN(num) && num >= 1 && num <= saved.length) {
          urlToConnect = saved[num - 1];
        } else {
          console.log(chalk.red('Invalid selection.'));
          return;
        }
      }
    }

    if (urlToConnect === this.adapter.connectionUrl && this.adapter.isConnected()) {
      console.log(chalk.yellow('\nAlready connected to this database.\n'));
      return;
    }

    try {
      detectDatabaseType(urlToConnect);
    } catch (e: any) {
      console.log(chalk.red(`Invalid connection URL: ${e.message}`));
      return;
    }

    const spinner = ora(`Connecting to ${maskUrl(urlToConnect)}...`).start();
    try {
      const newAdapter = createDatabaseAdapter(urlToConnect);
      await newAdapter.connect();
      await newAdapter.inspectSchema(true);

      // Disconnect previous adapter cleanly
      try {
        await this.adapter.disconnect();
      } catch {
        // Safe to ignore disconnect errors on transition
      }

      this.adapter = newAdapter;
      // Re-create agent for the new adapter while maintaining state & chat memory
      this.initAgent();

      addSavedConnection(urlToConnect);
      spinner.succeed(
        chalk.green(
          `Switched to ${newAdapter.type.toUpperCase()} database: ${newAdapter.databaseName} (${newAdapter.getMaskedUrl()})`
        )
      );
      console.log(
        chalk.gray(
          `Chat session [${this.sessionId}] continuing with conversation memory on the new database.\n`
        )
      );
    } catch (err: any) {
      spinner.fail(chalk.red(`Failed to connect to database: ${err.message}`));
    }
  }

  private async handleModelCommand(
    newModel: string,
    ask: (q: string) => Promise<string>
  ): Promise<void> {
    let targetModel = newModel;

    if (!targetModel) {
      console.log(
        chalk.bold.cyan(`\nCurrent Model: `) +
          chalk.white(this.modelName) +
          chalk.gray(` (${this.provider})`)
      );
      console.log(chalk.bold.yellow(`\nAvailable models for ${this.provider.toUpperCase()}:`));

      const list = getModelsForProvider(this.provider as LLMProvider);
      list.forEach((m, i) => {
        const isCurrent = m.id === this.modelName ? chalk.green(' (Current)') : '';
        const rec = m.recommended ? chalk.yellow(' [★ Recommended]') : '';
        const badge = m.badge ? chalk.dim(` [${m.badge}]`) : '';
        console.log(
          `  [${i + 1}] ${chalk.bold(m.id)}${rec}${badge}${isCurrent}\n      ${chalk.gray(
            `${m.name} (${m.contextWindow}) — ${m.description}`
          )}`
        );
      });
      console.log(chalk.gray('  [O] Other (type custom model name)'));
      console.log(chalk.gray('  [C] Cancel\n'));

      const input = (await ask(chalk.cyan('Select model [number, name, C]: '))).trim();
      if (!input || input.toLowerCase() === 'c') return;

      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= list.length) {
        targetModel = list[num - 1].id;
      } else if (input.toLowerCase() === 'o') {
        const custom = (await ask(chalk.cyan('Enter model name: '))).trim();
        if (!custom) return;
        targetModel = custom;
      } else {
        targetModel = input;
      }
    }

    if (!this.apiKey) {
      const resolved = resolveCredentials({ cliProvider: this.provider });
      if (resolved.apiKey) {
        this.apiKey = resolved.apiKey;
      } else {
        console.log(chalk.yellow(`\nNo API key found for ${this.provider.toUpperCase()}.`));
        this.apiKey = (await ask(chalk.cyan(`Enter API key for ${this.provider.toUpperCase()}: `))).trim();
        if (!this.apiKey) {
          console.log(chalk.red('API key is required.'));
          return;
        }
      }
    }

    try {
      this.model = createChatModel({
        provider: this.provider as LLMProvider,
        model: targetModel,
        apiKey: this.apiKey,
      });
      this.modelName = targetModel;
      this.initAgent();
      console.log(chalk.green(`\nUpdated active model to: ${targetModel} [${this.provider}]\n`));
    } catch (err: any) {
      console.log(chalk.red(`\nFailed to update model: ${err.message}\n`));
    }
  }

  private async handleProviderCommand(
    newProvider: string,
    ask: (q: string) => Promise<string>
  ): Promise<void> {
    let p = newProvider.toLowerCase().trim();
    if (!['google', 'openai', 'anthropic'].includes(p)) {
      console.log(chalk.bold.cyan(`\nCurrent Provider: `) + chalk.blue(this.provider));
      console.log('Available providers:');
      console.log('  [1] Google Gemini (google)');
      console.log('  [2] OpenAI (openai)');
      console.log('  [3] Anthropic (anthropic)');
      console.log('  [C] Cancel\n');

      const ans = (await ask(chalk.cyan('Select provider [1-3, name, C]: '))).trim().toLowerCase();
      if (!ans || ans === 'c') return;
      if (ans === '1' || ans === 'google') p = 'google';
      else if (ans === '2' || ans === 'openai') p = 'openai';
      else if (ans === '3' || ans === 'anthropic') p = 'anthropic';
      else {
        console.log(chalk.red('Invalid provider.'));
        return;
      }
    }

    const typedProvider = p as LLMProvider;

    // 1. Check if API key is stored for this provider
    let key = getStoredApiKeyForProvider(typedProvider);

    if (key) {
      console.log(
        chalk.gray(`Found stored API key for ${typedProvider.toUpperCase()} (${maskApiKey(key)})`)
      );
    } else {
      console.log(chalk.yellow(`\nNo stored API key found for ${typedProvider.toUpperCase()}.`));
      key = (await ask(chalk.cyan(`Enter API key for ${typedProvider.toUpperCase()}: `))).trim();
      while (!key) {
        console.log(chalk.red('API key cannot be empty.'));
        key = (await ask(chalk.cyan(`Enter API key for ${typedProvider.toUpperCase()} (or C to cancel): `))).trim();
        if (key.toLowerCase() === 'c') return;
      }

      const save = (
        await ask(chalk.cyan('Save this API key to ~/.sandal/config.json? (Y/n): '))
      )
        .trim()
        .toLowerCase();
      if (save !== 'n') {
        if (typedProvider === 'google') writeConfig({ geminiApiKey: key });
        else if (typedProvider === 'openai') writeConfig({ openaiApiKey: key });
        else if (typedProvider === 'anthropic') writeConfig({ anthropicApiKey: key });
      }
    }

    // 2. Prompt for model
    const providerModels = getModelsForProvider(typedProvider);
    console.log(chalk.bold.yellow(`\nAvailable models for ${typedProvider.toUpperCase()}:`));
    providerModels.forEach((m, i) => {
      const isCurrent = (typedProvider === this.provider && m.id === this.modelName) ? chalk.green(' (Current)') : '';
      const rec = m.recommended ? chalk.yellow(' [★ Recommended]') : '';
      const badge = m.badge ? chalk.dim(` [${m.badge}]`) : '';
      console.log(
        `  [${i + 1}] ${chalk.bold(m.id)}${rec}${badge}${isCurrent}\n      ${chalk.gray(
          `${m.name} (${m.contextWindow}) — ${m.description}`
        )}`
      );
    });

    const defaultModel = getDefaultModelForProvider(typedProvider);
    console.log(chalk.gray(`  [Enter] Default (${defaultModel})`));
    console.log(chalk.gray('  [O] Other (type custom model name)'));
    console.log(chalk.gray('  [C] Cancel\n'));

    const choice = (
      await ask(chalk.cyan(`Select model [1-${providerModels.length}, name, Enter]: `))
    ).trim();
    if (choice.toLowerCase() === 'c') return;

    let targetModel = defaultModel;
    const mNum = parseInt(choice, 10);
    if (!isNaN(mNum) && mNum >= 1 && mNum <= providerModels.length) {
      targetModel = providerModels[mNum - 1].id;
    } else if (choice.toLowerCase() === 'o') {
      const custom = (await ask(chalk.cyan('Enter custom model name: '))).trim();
      if (!custom) return;
      targetModel = custom;
    } else if (choice) {
      targetModel = choice;
    }

    // Optionally save default provider and model to config
    const saveDefault = (
      await ask(chalk.cyan(`Save ${typedProvider.toUpperCase()} and ${targetModel} as your default in ~/.sandal/config.json? (y/N): `))
    ).trim().toLowerCase();
    if (saveDefault === 'y' || saveDefault === 'yes') {
      writeConfig({
        defaultProvider: typedProvider,
        defaultModel: targetModel,
      });
      console.log(chalk.green('Saved default provider and model to ~/.sandal/config.json.'));
    }

    try {
      this.model = createChatModel({
        provider: typedProvider,
        model: targetModel,
        apiKey: key,
      });
      this.provider = typedProvider;
      this.modelName = targetModel;
      this.apiKey = key;
      this.initAgent();
      console.log(
        chalk.green(
          `\nSwitched provider to ${chalk.bold(typedProvider.toUpperCase())} with model ${chalk.bold(targetModel)}.\n`
        )
      );
    } catch (err: any) {
      console.log(chalk.red(`Failed to switch provider: ${err.message}\n`));
    }
  }

  private async handleKeyCommand(
    arg: string,
    ask: (q: string) => Promise<string>
  ): Promise<void> {
    const sub = arg.toLowerCase().trim();

    if (sub === 'remove' || sub === 'clear' || sub === 'delete') {
      const confirmAns = (
        await ask(chalk.yellow(`Remove stored API key for provider "${this.provider}"? (y/N): `))
      )
        .trim()
        .toLowerCase();
      if (confirmAns === 'y' || confirmAns === 'yes') {
        removeApiKey(this.provider as LLMProvider);
        this.apiKey = undefined;
        console.log(chalk.green(`\nRemoved stored API key for "${this.provider}" from ~/.sandal/config.json.`));
        console.log(chalk.gray(`Subsequent requests with this provider will prompt for a key.\n`));
      }
      return;
    }

    if (sub.startsWith('set')) {
      let newKey = sub.replace(/^set\s*/, '').trim();
      if (!newKey) {
        newKey = (await ask(chalk.cyan(`Enter new API key for ${this.provider}: `))).trim();
      }
      if (!newKey) {
        console.log(chalk.red('API key cannot be empty.'));
        return;
      }
      this.apiKey = newKey;
      if (this.provider === 'google') writeConfig({ geminiApiKey: newKey });
      else if (this.provider === 'openai') writeConfig({ openaiApiKey: newKey });
      else if (this.provider === 'anthropic') writeConfig({ anthropicApiKey: newKey });

      this.model = createChatModel({
        provider: this.provider as LLMProvider,
        model: this.modelName,
        apiKey: newKey,
      });
      this.initAgent();
      console.log(chalk.green(`\nUpdated API key for "${this.provider}" and refreshed model.\n`));
      return;
    }

    // Default: show current key status
    console.log(chalk.bold.cyan('\nAPI Key Status:'));
    console.log(`  Provider:   ${chalk.blue(this.provider)}`);
    console.log(`  Model:      ${chalk.white(this.modelName)}`);
    console.log(
      `  Active Key: ${this.apiKey ? chalk.yellow(maskApiKey(this.apiKey)) : chalk.red('None (not set)')}`
    );
    console.log(chalk.gray('\nUsage:'));
    console.log(chalk.gray('  .key remove         - Remove stored key from ~/.sandal/config.json'));
    console.log(chalk.gray('  .key set <api-key>  - Update API key on the fly\n'));
  }

  private handleListChats(): void {
    const list = this.memoryManager.listSessions();
    if (list.length === 0) {
      console.log(chalk.yellow('\nNo saved chat sessions found.\n'));
      return;
    }

    console.log(chalk.bold.cyan('\nSaved Chat Sessions:'));
    list.forEach((s, i) => {
      const isActive = s.id === this.sessionId;
      const activeMarker = isActive ? chalk.green(' [ACTIVE]') : '';
      const dateStr = new Date(s.updatedAt).toLocaleString();
      console.log(
        `  [${i + 1}] ${chalk.bold(s.title)}${activeMarker}\n      ID: ${chalk.gray(s.id)} | ${chalk.yellow(s.messageCount + ' messages')} | ${chalk.gray(dateStr)}`
      );
    });
    console.log(chalk.gray('\nCommands: .chat <id|num> to switch, .new to start fresh chat\n'));
  }

  private handleNewChat(): void {
    const newSession = this.memoryManager.createSession('New Chat', this.adapter.connectionUrl);
    this.sessionId = newSession.id;
    this.initAgent();
    console.log(chalk.green(`\nStarted fresh chat session: ${this.sessionId}`));
    console.log(chalk.gray('Chat memory is clean for this new session.\n'));
  }

  private handleSwitchChat(arg: string): void {
    const list = this.memoryManager.listSessions();
    let targetId: string | undefined;

    const num = parseInt(arg, 10);
    if (!isNaN(num) && num >= 1 && num <= list.length) {
      targetId = list[num - 1].id;
    } else {
      const found = list.find(
        (s) => s.id === arg || s.id.toLowerCase().includes(arg.toLowerCase())
      );
      if (found) targetId = found.id;
    }

    if (!targetId) {
      console.log(chalk.red(`\nChat session "${arg}" not found. Use .chats to list sessions.\n`));
      return;
    }

    const session = this.memoryManager.getSession(targetId);
    if (!session) {
      console.log(chalk.red(`\nCould not load chat session "${targetId}".\n`));
      return;
    }

    this.sessionId = session.id;
    this.initAgent();
    console.log(
      chalk.green(
        `\nSwitched to chat: "${session.title}" (${session.messages.length} messages in memory).\n`
      )
    );
  }

  private handleShowHistory(): void {
    const session = this.memoryManager.getSession(this.sessionId);
    if (!session || session.messages.length === 0) {
      console.log(chalk.yellow(`\nNo message history in current chat (${this.sessionId}).\n`));
      return;
    }

    console.log(chalk.bold.cyan(`\nChat History: "${session.title}" [${this.sessionId}]:`));
    console.log(chalk.gray('─'.repeat(60)));
    for (const msg of session.messages) {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      if (msg.role === 'user') {
        console.log(`${chalk.bold.blue('👤 User')} ${chalk.gray(`(${time})`)}:\n  ${msg.content}`);
      } else if (msg.role === 'assistant') {
        if (msg.query) {
          console.log(`  ${chalk.gray(`[Query: ${msg.query}]`)}`);
        }
        console.log(`${chalk.bold.green('🤖 Assistant')} ${chalk.gray(`(${time})`)}:\n  ${msg.content}`);
      }
      console.log(chalk.gray('─'.repeat(60)));
    }
    console.log('');
  }

  private handleClearChat(): void {
    this.memoryManager.clearSession(this.sessionId);
    this.initAgent();
    console.log(chalk.green(`\nChat memory for session [${this.sessionId}] has been cleared.\n`));
  }

  private handleRenderMarkdown(arg: string): void {
    if (!arg) {
      console.log(chalk.yellow('Usage: .md <markdown text or file path>'));
      console.log(chalk.gray('Example: .md # Hello World'));
      console.log(chalk.gray('Example: .md ./README.md'));
      return;
    }

    try {
      if (fs.existsSync(arg) && fs.statSync(arg).isFile()) {
        const fileContent = fs.readFileSync(arg, 'utf-8');
        console.log('\n' + renderMarkdown(fileContent) + '\n');
        return;
      }
    } catch {
      // Not a file, proceed to render arg as raw markdown text
    }

    console.log('\n' + renderMarkdown(arg) + '\n');
  }

  private renderRowsTable(queryResult: any): void {
    const rows = queryResult.rows;
    if (!rows || rows.length === 0) {
      console.log(chalk.gray('(0 rows returned)'));
      return;
    }

    const fields =
      queryResult.fields && queryResult.fields.length > 0
        ? queryResult.fields
        : Object.keys(rows[0] || {});

    if (fields.length === 0) return;

    // Limit display to 25 rows
    const displayRows = rows.slice(0, 25);
    const table = new Table({
      head: fields.map((f: string) => chalk.cyan.bold(f)),
      style: { head: [], border: ['gray'] },
    });

    for (const r of displayRows) {
      table.push(
        fields.map((f: string) => {
          const val = r[f];
          if (val === null || val === undefined) return chalk.gray('NULL');
          if (typeof val === 'object') {
            try {
              return JSON.stringify(val);
            } catch {
              return String(val);
            }
          }
          return String(val);
        })
      );
    }

    console.log(table.toString());
    if (rows.length > 25) {
      console.log(chalk.yellow(`Showing first 25 of ${rows.length.toLocaleString()} rows.`));
    }
    console.log(
      chalk.gray(
        `Total rows: ${queryResult.rowCount ?? rows.length} | Execution duration: ${queryResult.durationMs}ms\n`
      )
    );
  }

  private async handleListEntities(): Promise<void> {
    const spinner = ora(chalk.blue('Inspecting schema...')).start();
    try {
      const schema = await this.adapter.inspectSchema(false);
      spinner.stop();

      if (schema.type === 'postgres') {
        const tables = schema.tables || [];
        if (tables.length === 0) {
          console.log(chalk.yellow('No tables found in public schema.'));
          return;
        }
        console.log(chalk.bold.cyan(`\nTables in "${schema.databaseName}":`));
        for (const t of tables) {
          console.log(
            `  • ${chalk.bold(t.name)} ${chalk.gray(`(~${t.approximateRowCount ?? 0} rows, ${t.columns.length} columns)`)}`
          );
        }
        console.log('');
      } else {
        const collections = schema.collections || [];
        if (collections.length === 0) {
          console.log(chalk.yellow('No collections found.'));
          return;
        }
        console.log(chalk.bold.cyan(`\nCollections in "${schema.databaseName}":`));
        for (const c of collections) {
          console.log(
            `  • ${chalk.bold(c.name)} ${chalk.gray(`(${c.documentCount ?? 0} docs, ${c.fields.length} sampled fields)`)}`
          );
        }
        console.log('');
      }
    } catch (err: any) {
      spinner.fail(chalk.red(`Failed to list entities: ${err.message}`));
    }
  }

  private async handleShowSchema(entityName?: string): Promise<void> {
    const spinner = ora(chalk.blue('Fetching schema details...')).start();
    try {
      const schema = await this.adapter.inspectSchema(false);
      spinner.stop();

      if (!entityName) {
        console.log('\n' + formatSchemaForPrompt(schema) + '\n');
        return;
      }

      if (schema.type === 'postgres') {
        const table = (schema.tables || []).find(
          (t) => t.name.toLowerCase() === entityName.toLowerCase()
        );
        if (!table) {
          console.log(chalk.red(`Table "${entityName}" not found.`));
          return;
        }

        console.log(chalk.bold.cyan(`\nSchema for table: ${table.schema}.${table.name}`));
        const tableDetails = new Table({
          head: ['Column', 'Data Type', 'Nullable', 'Primary Key', 'Default'].map((h) =>
            chalk.cyan.bold(h)
          ),
        });
        for (const c of table.columns) {
          tableDetails.push([
            c.name,
            c.dataType,
            c.isNullable ? 'YES' : 'NO',
            c.isPrimaryKey ? chalk.green('YES') : 'NO',
            c.defaultValue ?? chalk.gray('NULL'),
          ]);
        }
        console.log(tableDetails.toString());
      } else {
        const collection = (schema.collections || []).find(
          (c) => c.name.toLowerCase() === entityName.toLowerCase()
        );
        if (!collection) {
          console.log(chalk.red(`Collection "${entityName}" not found.`));
          return;
        }

        console.log(chalk.bold.cyan(`\nSchema for collection: ${collection.name}`));
        const colDetails = new Table({
          head: ['Field', 'Inferred Types'].map((h) => chalk.cyan.bold(h)),
        });
        for (const f of collection.fields) {
          colDetails.push([f.name, f.types.join(', ')]);
        }
        console.log(colDetails.toString());
      }
    } catch (err: any) {
      spinner.fail(chalk.red(`Failed to inspect schema: ${err.message}`));
    }
  }

  private printWelcomeBanner(): void {
    const banner = [
      chalk.bold.cyan('SANDAL: Safe Agentic Natural-language Database Access Layer'),
      chalk.gray('LangGraph + Multi-Provider AI (Gemini, OpenAI, Anthropic)'),
      '',
      `${chalk.bold('Database:')}      ${chalk.green(this.adapter.type.toUpperCase())} (${this.adapter.getMaskedUrl()})`,
      `${chalk.bold('LLM Provider:')}  ${chalk.blue(this.provider)} [${chalk.white(this.modelName)}]`,
      `${chalk.bold('Chat Session:')}  ${chalk.yellow(this.sessionId)}`,
      `${chalk.bold('Strict Mode:')}   ${this.strictMode ? chalk.green('ON (Full wipes blocked)') : chalk.yellow('OFF')}`,
      `${chalk.bold('Markdown:')}      ${this.renderMarkdown ? chalk.green('ENABLED') : chalk.gray('DISABLED')}`,
      '',
      chalk.gray('Type your natural language request or SQL/Mongo query.'),
      chalk.gray('Commands: .connect, .model, .chats, .new, .history, .key, .help, exit'),
    ].join('\n');

    console.log(
      boxen(banner, {
        padding: 1,
        borderColor: 'cyan',
        borderStyle: 'round',
        margin: { top: 1, bottom: 1 },
      })
    );
  }

  private printHelp(): void {
    console.log(
      boxen(
        [
          chalk.bold.cyan('SANDAL REPL Commands:'),
          '',
          `${chalk.bold('.tables / .collections')}   List all tables or collections with row counts`,
          `${chalk.bold('.schema [name]')}           Show columns, types, and indexes for a table`,
          `${chalk.bold('.connect / .switch')}       Switch database connection (shows saved connections)`,
          `${chalk.bold('.model [name]')}            Change active LLM model on the fly`,
          `${chalk.bold('.provider [name]')}         Switch LLM provider (google, openai, anthropic)`,
          `${chalk.bold('.key [remove | set]')}      View, remove, or update API key`,
          `${chalk.bold('.chats')}                   List saved chat sessions`,
          `${chalk.bold('.chat <id | num>')}         Switch to another chat session`,
          `${chalk.bold('.new')}                     Start a fresh chat session with clear memory`,
          `${chalk.bold('.history')}                 Show conversation history for current chat`,
          `${chalk.bold('.clear-chat')}              Clear memory for current chat`,
          `${chalk.bold('.md [file | text]')}        Render markdown file or text in terminal`,
          `${chalk.bold('.refresh')}                 Force refresh cached schema introspection`,
          `${chalk.bold('.clear')}                   Clear terminal screen`,
          `${chalk.bold('.help')}                    Display this command reference`,
          `${chalk.bold('exit / quit')}              Gracefully disconnect and exit`,
          '',
          chalk.bold.yellow('Example Natural Language Requests:'),
          '  "Show top 10 users signed up in the last 30 days"',
          '  "Now count how many of them are active" (multi-turn follow-up)',
          '  "Calculate total revenue grouped by product category"',
          '  "Add a concurrent index on orders(created_at)"',
        ].join('\n'),
        {
          padding: 1,
          borderColor: 'gray',
          borderStyle: 'single',
          margin: { top: 0, bottom: 1 },
        }
      )
    );
  }

  private setupSignalHandlers(): void {
    const handleExit = async () => {
      this.isRunning = false;
      await this.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);
  }

  public async shutdown(): Promise<void> {
    if (this.rl && !(this.rl as any).closed) {
      this.rl.close();
    }
    if (this.adapter.isConnected()) {
      try {
        await this.adapter.disconnect();
      } catch {
        // ignore on exit
      }
    }
    console.log(chalk.cyan('\nDatabase connection closed. Goodbye! 👋\n'));
  }
}
