import { describe, it, expect, vi } from 'vitest';
import { createDatabaseAgent } from '../src/agent/graph.js';
import { DatabaseAdapter, DatabaseSchema, ExecutableQuery, QueryResult } from '../src/db/adapter.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, BaseMessage } from '@langchain/core/messages';

class MockChatModel extends BaseChatModel {
  public invokeHandler: (messages: BaseMessage[]) => Promise<AIMessage>;

  constructor(handler: (messages: BaseMessage[]) => Promise<AIMessage>) {
    super({});
    this.invokeHandler = handler;
  }

  _llmType(): string {
    return 'mock';
  }

  async _generate(): Promise<any> {
    throw new Error('Not implemented');
  }

  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    return this.invokeHandler(messages);
  }
}

function createMockAdapter(): DatabaseAdapter {
  const schema: DatabaseSchema = {
    type: 'postgres',
    databaseName: 'testdb',
    tables: [
      {
        name: 'users',
        schema: 'public',
        columns: [
          { name: 'id', dataType: 'integer', isNullable: false, isPrimaryKey: true },
          { name: 'name', dataType: 'varchar', isNullable: false },
          { name: 'role', dataType: 'varchar', isNullable: false },
        ],
        indexes: [],
        foreignKeys: [],
        approximateRowCount: 2,
      },
    ],
    inspectedAt: new Date(),
  };

  return {
    type: 'postgres',
    databaseName: 'testdb',
    connectionUrl: 'postgres://localhost/testdb',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    inspectSchema: vi.fn().mockResolvedValue(schema),
    executeQuery: vi.fn().mockImplementation(async (q: ExecutableQuery): Promise<QueryResult> => {
      return {
        success: true,
        rows: [
          { id: 1, name: 'Alice', role: 'admin' },
          { id: 2, name: 'Bob', role: 'member' },
        ],
        rowCount: 2,
        durationMs: 4,
      };
    }),
    dryRunCount: vi.fn().mockResolvedValue(2),
    explainQuery: vi.fn().mockResolvedValue('Seq Scan on users'),
    getMaskedUrl: vi.fn().mockReturnValue('postgres://localhost/testdb'),
  };
}

describe('Database Agent - Conditional Query Execution & No-Query Safeguards', () => {
  it('executes a query when live data retrieval is requested', async () => {
    const adapter = createMockAdapter();
    const confirmFn = vi.fn().mockResolvedValue({ confirmed: true });

    const model = new MockChatModel(async (messages: BaseMessage[]) => {
      const lastMsg = messages[messages.length - 1].content.toString();
      if (lastMsg.includes('relevant table names')) {
        return new AIMessage('["users"]');
      }
      if (lastMsg.includes('Generate the appropriate database query')) {
        return new AIMessage(JSON.stringify({ sql: 'SELECT * FROM users;' }));
      }
      return new AIMessage('Here are 2 users: Alice and Bob.');
    });

    const agent = createDatabaseAgent({
      adapter,
      model,
      confirmFn,
    });

    const result = await agent.invoke(
      { userInput: 'show all users' },
      { configurable: { thread_id: 'test-session-1' } }
    );

    expect(result.queryExecuted).toBe(true);
    expect(result.generatedQuery?.sql).toBe('SELECT * FROM users;');
    expect(result.queryResult?.rows?.length).toBe(2);
    expect(result.conclusion).toContain('Alice and Bob');
    expect(adapter.executeQuery).toHaveBeenCalledTimes(1);
    expect(confirmFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT run a query when explicitly instructed "don\'t run the query, just do something with the previous results"', async () => {
    const adapter = createMockAdapter();
    const confirmFn = vi.fn().mockResolvedValue({ confirmed: true });

    let lastDirectPrompt = '';
    const model = new MockChatModel(async (messages: BaseMessage[]) => {
      const lastMsg = messages[messages.length - 1].content.toString();
      if (lastMsg.includes('relevant table names')) {
        return new AIMessage('["users"]');
      }
      if (lastMsg.includes('Generate the appropriate database query')) {
        return new AIMessage(JSON.stringify({ sql: 'SELECT * FROM users;' }));
      }
      if (lastMsg.includes('WITHOUT generating or executing any database query')) {
        lastDirectPrompt = lastMsg;
        return new AIMessage('Previous results list: 1. Alice (admin), 2. Bob (member)');
      }
      return new AIMessage('Query executed. 2 rows returned.');
    });

    const agent = createDatabaseAgent({
      adapter,
      model,
      confirmFn,
    });

    // Turn 1: Run a query to populate previous results
    const turn1 = await agent.invoke(
      { userInput: 'show all users' },
      { configurable: { thread_id: 'test-session-2' } }
    );
    expect(turn1.queryExecuted).toBe(true);
    expect(adapter.executeQuery).toHaveBeenCalledTimes(1);
    expect(confirmFn).toHaveBeenCalledTimes(1);

    // Turn 2: User explicitly instructs not to run query and use previous results
    const turn2 = await agent.invoke(
      { userInput: "don't run the query, just do something with the previous results" },
      { configurable: { thread_id: 'test-session-2' } }
    );

    // Query must NOT have been executed or confirmed on Turn 2
    expect(turn2.queryExecuted).toBe(false);
    expect(turn2.generatedQuery).toBeUndefined();
    expect(turn2.queryResult).toBeUndefined();
    expect(adapter.executeQuery).toHaveBeenCalledTimes(1); // Still 1 from Turn 1!
    expect(confirmFn).toHaveBeenCalledTimes(1); // Still 1 from Turn 1!

    // Direct answer must have received the previous query results
    expect(lastDirectPrompt).toContain('PREVIOUS QUERY EXECUTION DETAILS:');
    expect(lastDirectPrompt).toContain('Alice');
    expect(lastDirectPrompt).toContain('Bob');
    expect(turn2.conclusion).toContain('Alice (admin)');
  });

  it('does NOT run a query when user asks to explain the database schema', async () => {
    const adapter = createMockAdapter();
    const confirmFn = vi.fn().mockResolvedValue({ confirmed: true });

    const model = new MockChatModel(async (messages: BaseMessage[]) => {
      return new AIMessage('The schema has a users table with id, name, and role columns.');
    });

    const agent = createDatabaseAgent({
      adapter,
      model,
      confirmFn,
    });

    const result = await agent.invoke(
      { userInput: 'explain what tables and columns are in the schema' },
      { configurable: { thread_id: 'test-session-3' } }
    );

    expect(result.queryExecuted).toBe(false);
    expect(result.generatedQuery).toBeUndefined();
    expect(result.queryResult).toBeUndefined();
    expect(adapter.executeQuery).not.toHaveBeenCalled();
    expect(confirmFn).not.toHaveBeenCalled();
    expect(result.conclusion).toContain('users table');
  });

  it('does NOT run a query when user says "without running a query, what was the highest ID in the results?"', async () => {
    const adapter = createMockAdapter();
    const confirmFn = vi.fn().mockResolvedValue({ confirmed: true });

    const model = new MockChatModel(async (messages: BaseMessage[]) => {
      const lastMsg = messages[messages.length - 1].content.toString();
      if (lastMsg.includes('Generate the appropriate database query')) {
        return new AIMessage(JSON.stringify({ sql: 'SELECT * FROM users;' }));
      }
      if (lastMsg.includes('WITHOUT generating or executing any database query')) {
        return new AIMessage('The highest ID in the previous results was 2 (Bob).');
      }
      return new AIMessage('2 rows found.');
    });

    const agent = createDatabaseAgent({
      adapter,
      model,
      confirmFn,
    });

    // Turn 1
    await agent.invoke(
      { userInput: 'fetch all users' },
      { configurable: { thread_id: 'test-session-4' } }
    );

    // Turn 2
    const turn2 = await agent.invoke(
      { userInput: 'without running a query, what was the highest ID in the results?' },
      { configurable: { thread_id: 'test-session-4' } }
    );

    expect(turn2.queryExecuted).toBe(false);
    expect(turn2.generatedQuery).toBeUndefined();
    expect(adapter.executeQuery).toHaveBeenCalledTimes(1); // Only Turn 1
    expect(turn2.conclusion).toContain('highest ID');
  });

  it('handles formatting previous results as a table without re-running a query', async () => {
    const adapter = createMockAdapter();
    const confirmFn = vi.fn().mockResolvedValue({ confirmed: true });

    const model = new MockChatModel(async (messages: BaseMessage[]) => {
      const lastMsg = messages[messages.length - 1].content.toString();
      if (lastMsg.includes('Generate the appropriate database query')) {
        return new AIMessage(JSON.stringify({ sql: 'SELECT * FROM users;' }));
      }
      if (lastMsg.includes('WITHOUT generating or executing any database query')) {
        return new AIMessage('| ID | Name | Role |\n|---|---|---|\n| 1 | Alice | admin |\n| 2 | Bob | member |');
      }
      return new AIMessage('Found users.');
    });

    const agent = createDatabaseAgent({
      adapter,
      model,
      confirmFn,
    });

    // Turn 1
    await agent.invoke(
      { userInput: 'SELECT * FROM users;' },
      { configurable: { thread_id: 'test-session-5' } }
    );

    // Turn 2: "format the previous results as a markdown table"
    const turn2 = await agent.invoke(
      { userInput: 'format the previous results as a markdown table' },
      { configurable: { thread_id: 'test-session-5' } }
    );

    expect(turn2.queryExecuted).toBe(false);
    expect(adapter.executeQuery).toHaveBeenCalledTimes(1); // Only Turn 1
    expect(turn2.conclusion).toContain('| ID | Name | Role |');
  });

  it('routes to direct answer when LLM router determines query is not required', async () => {
    const adapter = createMockAdapter();
    const confirmFn = vi.fn().mockResolvedValue({ confirmed: true });

    const model = new MockChatModel(async (messages: BaseMessage[]) => {
      const lastMsg = messages[messages.length - 1].content.toString();
      if (lastMsg.includes('Determine whether fulfilling this user request requires generating and executing a LIVE database query')) {
        return new AIMessage(JSON.stringify({ requiresQuery: false, reason: 'Can be answered conversationally' }));
      }
      if (lastMsg.includes('WITHOUT generating or executing any database query')) {
        return new AIMessage('PostgreSQL is relational with ACID transactions, while MongoDB is document-oriented.');
      }
      return new AIMessage('Default response');
    });

    const agent = createDatabaseAgent({
      adapter,
      model,
      confirmFn,
    });

    const result = await agent.invoke(
      { userInput: 'can you compare postgres and mongodb?' },
      { configurable: { thread_id: 'test-session-6' } }
    );

    expect(result.queryExecuted).toBe(false);
    expect(result.generatedQuery).toBeUndefined();
    expect(adapter.executeQuery).not.toHaveBeenCalled();
    expect(result.conclusion).toContain('relational with ACID transactions');
  });

  it('handles explicit no-query instruction on MongoDB adapter', async () => {
    const mongoSchema: DatabaseSchema = {
      type: 'mongodb',
      databaseName: 'shop',
      collections: [
        {
          name: 'products',
          fields: [{ name: 'title', types: ['string'] }, { name: 'price', types: ['number'] }],
          indexes: [],
          documentCount: 10,
        },
      ],
      inspectedAt: new Date(),
    };

    const mongoAdapter: DatabaseAdapter = {
      type: 'mongodb',
      databaseName: 'shop',
      connectionUrl: 'mongodb://localhost:27017/shop',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      inspectSchema: vi.fn().mockResolvedValue(mongoSchema),
      executeQuery: vi.fn().mockResolvedValue({
        success: true,
        rows: [{ title: 'Shoe', price: 99 }, { title: 'Shirt', price: 29 }],
        rowCount: 2,
        durationMs: 3,
      }),
      dryRunCount: vi.fn().mockResolvedValue(2),
      explainQuery: vi.fn().mockResolvedValue('COLLSCAN'),
      getMaskedUrl: vi.fn().mockReturnValue('mongodb://localhost:27017/shop'),
    };

    const confirmFn = vi.fn().mockResolvedValue({ confirmed: true });

    const model = new MockChatModel(async (messages: BaseMessage[]) => {
      const lastMsg = messages[messages.length - 1].content.toString();
      if (lastMsg.includes('relevant table names')) {
        return new AIMessage('["products"]');
      }
      if (lastMsg.includes('Generate the appropriate database query')) {
        return new AIMessage(JSON.stringify({ collection: 'products', operation: 'find', filter: {} }));
      }
      if (lastMsg.includes('WITHOUT generating or executing any database query')) {
        return new AIMessage('Average price from previous results is $64.');
      }
      return new AIMessage('2 products found.');
    });

    const agent = createDatabaseAgent({
      adapter: mongoAdapter,
      model,
      confirmFn,
    });

    // Turn 1
    await agent.invoke(
      { userInput: 'find all products' },
      { configurable: { thread_id: 'mongo-session-1' } }
    );
    expect(mongoAdapter.executeQuery).toHaveBeenCalledTimes(1);

    // Turn 2
    const turn2 = await agent.invoke(
      { userInput: "don't run the query, calculate average price from previous results" },
      { configurable: { thread_id: 'mongo-session-1' } }
    );

    expect(turn2.queryExecuted).toBe(false);
    expect(turn2.generatedQuery).toBeUndefined();
    expect(mongoAdapter.executeQuery).toHaveBeenCalledTimes(1); // Still 1!
    expect(turn2.conclusion).toContain('Average price from previous results is $64.');
  });
});
