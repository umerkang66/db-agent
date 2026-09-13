import readline from 'node:readline';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import Table from 'cli-table3';
import { DatabaseAdapter } from './db/adapter.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createDatabaseAgent } from './agent/graph.js';
import { classifyIntent, REFUSAL_MESSAGE } from './agent/guardrails.js';
import { ClassifierOptions } from './safety/classifier.js';
import { formatSchemaForPrompt } from './agent/prompts.js';

export interface ReplOptions {
  adapter: DatabaseAdapter;
  model: BaseChatModel;
  provider: string;
  modelName: string;
  strictMode: boolean;
  allowFullWipe: boolean;
  rowThreshold?: number;
}

export class ReplSession {
  private adapter: DatabaseAdapter;
  private model: BaseChatModel;
  private provider: string;
  private modelName: string;
  private strictMode: boolean;
  private allowFullWipe: boolean;
  private rowThreshold: number;
  private isRunning = true;
  private sessionId = `session-${Date.now()}`;
  private agent: ReturnType<typeof createDatabaseAgent>;

  constructor(options: ReplOptions) {
    this.adapter = options.adapter;
    this.model = options.model;
    this.provider = options.provider;
    this.modelName = options.modelName;
    this.strictMode = options.strictMode;
    this.allowFullWipe = options.allowFullWipe;
    this.rowThreshold = options.rowThreshold ?? 50;

    const classifierOptions: ClassifierOptions = {
      strictMode: this.strictMode,
      allowFullWipe: this.allowFullWipe,
      rowThresholdForDangerousUpdate: this.rowThreshold,
    };

    this.agent = createDatabaseAgent({
      adapter: this.adapter,
      model: this.model,
      classifierOptions,
    });
  }

  public async start(): Promise<void> {
    this.setupSignalHandlers();
    this.printWelcomeBanner();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const promptText = chalk.cyan(`db-agent [${this.adapter.type}]> `);

    const askQuestion = (query: string): Promise<string> => {
      return new Promise((resolve) => rl.question(query, resolve));
    };

    while (this.isRunning) {
      const input = await askQuestion(promptText);
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

      // 1. INTENT GUARDRAILS CHECK
      const intentSpinner = ora(chalk.blue('Analyzing intent...')).start();
      const intent = await classifyIntent(trimmed, this.model);
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

      // 2. RUN AGENT GRAPH
      const agentSpinner = ora(chalk.cyan('Agent planning query...')).start();

      try {
        const result = await this.agent.invoke(
          {
            userInput: trimmed,
          },
          {
            configurable: {
              thread_id: this.sessionId,
            },
          }
        );

        agentSpinner.stop();

        // If query was executed and returned rows, render table
        if (result.queryResult && result.queryResult.success && result.queryResult.rows) {
          this.renderRowsTable(result.queryResult);
        }

        // Print final conclusion
        if (result.conclusion) {
          console.log('\n' + chalk.green('🤖 Answer:'));
          console.log(chalk.white(result.conclusion) + '\n');
        }
      } catch (err: any) {
        agentSpinner.fail(chalk.red(`Execution failed: ${err.message}`));
      }
    }

    rl.close();
    await this.shutdown();
  }

  private renderRowsTable(queryResult: any): void {
    const rows = queryResult.rows;
    if (!rows || rows.length === 0) {
      console.log(chalk.gray('(0 rows returned)'));
      return;
    }

    const fields = queryResult.fields && queryResult.fields.length > 0
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
        `Total rows: ${queryResult.rowCount ?? rows.length} | Duration: ${queryResult.durationMs ?? 0}ms`
      )
    );
  }

  private async handleListEntities(): Promise<void> {
    const spinner = ora(chalk.blue('Loading schema...')).start();
    try {
      const schema = await this.adapter.inspectSchema();
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
            `  • ${chalk.white.bold(t.schema + '.' + t.name)} (~${(t.approximateRowCount ?? 0).toLocaleString()} rows, ${t.columns.length} columns)`
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
            `  • ${chalk.white.bold(c.name)} (~${(c.documentCount ?? 0).toLocaleString()} documents, ${c.fields.length} inferred fields)`
          );
        }
        console.log('');
      }
    } catch (err: any) {
      spinner.fail(chalk.red(`Failed to fetch entities: ${err.message}`));
    }
  }

  private async handleShowSchema(entityName?: string): Promise<void> {
    const spinner = ora(chalk.blue('Loading schema details...')).start();
    try {
      const schema = await this.adapter.inspectSchema();
      spinner.stop();

      if (!entityName) {
        console.log('\n' + formatSchemaForPrompt(schema) + '\n');
        return;
      }

      if (schema.type === 'postgres') {
        const table = schema.tables?.find(
          (t) => t.name.toLowerCase() === entityName.toLowerCase() || `${t.schema}.${t.name}`.toLowerCase() === entityName.toLowerCase()
        );
        if (!table) {
          console.log(chalk.red(`Table "${entityName}" not found.`));
          return;
        }
        console.log(chalk.bold.cyan(`\nSchema for table: ${table.schema}.${table.name}`));
        const tableDetails = new Table({
          head: ['Column', 'Type', 'Nullable', 'Default', 'Primary Key'].map((h) => chalk.cyan.bold(h)),
        });
        for (const col of table.columns) {
          tableDetails.push([
            col.name,
            col.dataType,
            col.isNullable ? 'YES' : 'NO',
            col.defaultValue || '-',
            col.isPrimaryKey ? 'PK' : '',
          ]);
        }
        console.log(tableDetails.toString());
      } else {
        const collection = schema.collections?.find((c) => c.name.toLowerCase() === entityName.toLowerCase());
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
      chalk.bold.cyan('🤖 db-agent — Production-Grade Agentic Database Assistant'),
      chalk.gray('LangGraph + Multi-Provider AI (Gemini, OpenAI, Anthropic)'),
      '',
      `${chalk.bold('Database:')} ${chalk.green(this.adapter.type.toUpperCase())} (${this.adapter.getMaskedUrl()})`,
      `${chalk.bold('LLM Provider:')} ${chalk.blue(this.provider)} [${chalk.white(this.modelName)}]`,
      `${chalk.bold('Strict Mode:')} ${this.strictMode ? chalk.green('ON (Full wipes blocked)') : chalk.yellow('OFF')}`,
      `${chalk.bold('Allow Full Wipe:')} ${this.allowFullWipe ? chalk.red('ENABLED') : chalk.gray('NO')}`,
      '',
      chalk.gray('Type your natural language request or SQL/Mongo query.'),
      chalk.gray('Commands: .tables, .schema [name], .refresh, .help, exit'),
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
          chalk.bold.cyan('db-agent REPL Commands:'),
          '',
          `${chalk.bold('.tables / .collections')}   List all tables or collections with row counts`,
          `${chalk.bold('.schema [name]')}           Show columns, types, and indexes for a table`,
          `${chalk.bold('.refresh')}                 Force refresh cached schema introspection`,
          `${chalk.bold('.clear')}                   Clear terminal screen`,
          `${chalk.bold('.help')}                    Display this command reference`,
          `${chalk.bold('exit / quit')}              Gracefully disconnect and exit`,
          '',
          chalk.bold.yellow('Example Natural Language Requests:'),
          '  "Show top 10 users signed up in the last 30 days"',
          '  "Calculate total revenue grouped by product category"',
          '  "Add a concurrent index on orders(created_at)"',
          '  "Delete users where status is inactive"',
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
