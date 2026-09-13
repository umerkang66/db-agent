import { Annotation, StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { DatabaseAdapter, DatabaseSchema, ExecutableQuery, QueryResult } from '../db/adapter.js';
import { classifyQuery, SafetyClassification, ClassifierOptions } from '../safety/classifier.js';
import { requestUserConfirmation, ConfirmationResult } from '../safety/confirm.js';
import { checkStrictWipe } from './guardrails.js';
import { getSystemPrompt, formatSchemaForPrompt } from './prompts.js';

export interface GraphConfig {
  adapter: DatabaseAdapter;
  model: BaseChatModel;
  classifierOptions?: ClassifierOptions;
  confirmFn?: (
    query: ExecutableQuery,
    safety: SafetyClassification,
    affectedRows: number | null
  ) => Promise<ConfirmationResult>;
}

export const AgentStateAnnotation = Annotation.Root({
  userInput: Annotation<string>({
    reducer: (_, update) => update,
    default: () => '',
  }),
  schema: Annotation<DatabaseSchema | undefined>({
    reducer: (curr, update) => update ?? curr,
    default: () => undefined,
  }),
  schemaSummary: Annotation<string>({
    reducer: (curr, update) => update ?? curr ?? '',
    default: () => '',
  }),
  targetEntities: Annotation<string[]>({
    reducer: (_, update) => update ?? [],
    default: () => [],
  }),
  generatedQuery: Annotation<ExecutableQuery | undefined>({
    reducer: (_, update) => update,
    default: () => undefined,
  }),
  safety: Annotation<SafetyClassification | undefined>({
    reducer: (_, update) => update,
    default: () => undefined,
  }),
  affectedRowCount: Annotation<number | null | undefined>({
    reducer: (_, update) => update,
    default: () => null,
  }),
  confirmed: Annotation<boolean>({
    reducer: (_, update) => update ?? false,
    default: () => false,
  }),
  cancelReason: Annotation<string | undefined>({
    reducer: (_, update) => update,
    default: () => undefined,
  }),
  queryResult: Annotation<QueryResult | undefined>({
    reducer: (_, update) => update,
    default: () => undefined,
  }),
  analysis: Annotation<string | undefined>({
    reducer: (_, update) => update,
    default: () => undefined,
  }),
  stats: Annotation<any>({
    reducer: (_, update) => update,
    default: () => undefined,
  }),
  conclusion: Annotation<string | undefined>({
    reducer: (_, update) => update,
    default: () => undefined,
  }),
  requiresSchemaRefresh: Annotation<boolean>({
    reducer: (_, update) => update ?? false,
    default: () => false,
  }),
  messages: Annotation<BaseMessage[]>({
    reducer: (curr, update) => curr.concat(update ?? []),
    default: () => [],
  }),
});

export type AgentStateType = typeof AgentStateAnnotation.State;

export function createDatabaseAgent(config: GraphConfig) {
  const { adapter, model, classifierOptions = {} } = config;

  // Node 1: inspect_schema
  async function inspectSchemaNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    let schema = state.schema;
    const forceRefresh = state.requiresSchemaRefresh || !schema;

    if (forceRefresh) {
      schema = await adapter.inspectSchema(true);
    }

    const summary = schema ? formatSchemaForPrompt(schema) : '';
    return {
      schema,
      schemaSummary: summary,
      requiresSchemaRefresh: false,
    };
  }

  // Node 2: identify_targets
  async function identifyTargetsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const historyMessages: BaseMessage[] = state.messages.slice(-4);
    const prompt = `Based on this user request: "${state.userInput}"
And the available database schema:
${state.schemaSummary}

List the relevant table names (PostgreSQL) or collection names (MongoDB) needed to fulfill the request.
Respond with a JSON array of string names only, e.g. ["users", "orders"]. Do not include markdown codeblocks or extra text.`;

    try {
      const response = await model.invoke([
        ...historyMessages,
        new HumanMessage(prompt),
      ]);
      const content = typeof response.content === 'string' ? response.content.trim() : '';
      const match = content.match(/\[[\s\S]*?\]/);
      const targets = match ? JSON.parse(match[0]) : [];
      return { targetEntities: Array.isArray(targets) ? targets : [] };
    } catch {
      return { targetEntities: [] };
    }
  }

  // Node 3: generate_query
  async function generateQueryNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const systemPrompt = getSystemPrompt(adapter.type, state.schemaSummary);

    const historyMessages: BaseMessage[] = state.messages.slice(-6); // last 3 turns
    const userPrompt = `User request: "${state.userInput}"
Target entities: ${JSON.stringify(state.targetEntities)}

Generate the appropriate database query to execute.
Ensure you return valid JSON formatted as specified in the system prompt.
Do not wrap with markdown or code fences.`;

    const response = await model.invoke([
      new SystemMessage(systemPrompt),
      ...historyMessages,
      new HumanMessage(userPrompt),
    ]);

    const content = typeof response.content === 'string' ? response.content.trim() : '';
    let parsed: any = null;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // Fallback
    }

    let query: ExecutableQuery;
    if (adapter.type === 'postgres') {
      const sql = parsed?.sql || content.replace(/```(?:sql|json)?/g, '').trim();
      query = {
        sql,
        params: parsed?.params || [],
        rawDisplay: sql,
      };
    } else {
      if (parsed && parsed.collection && parsed.operation) {
        query = {
          collection: parsed.collection,
          operation: parsed.operation,
          filter: parsed.filter,
          update: parsed.update,
          pipeline: parsed.pipeline,
          document: parsed.document,
          documents: parsed.documents,
          options: parsed.options,
          rawDisplay: JSON.stringify(parsed, null, 2),
        };
      } else {
        query = {
          rawDisplay: content,
        };
      }
    }

    return { generatedQuery: query };
  }

  // Node 4: classify_safety
  async function classifySafetyNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    if (!state.generatedQuery) {
      return {
        confirmed: false,
        cancelReason: 'No query was generated.',
      };
    }

    const safety = classifyQuery(state.generatedQuery, adapter.type, classifierOptions);

    // Strict mode check: hard block full wipes unless explicitly allowed
    const strictCheck = checkStrictWipe(safety, classifierOptions);
    if (strictCheck.blocked) {
      return {
        safety,
        confirmed: false,
        cancelReason: strictCheck.message,
      };
    }

    // Dry run affected count for mutating / dangerous queries
    let affectedRows: number | null = null;
    if (safety.isDestructive || safety.category === 'write' || safety.category === 'dangerous') {
      try {
        affectedRows = await adapter.dryRunCount(state.generatedQuery);
      } catch {
        affectedRows = null;
      }
    }

    return {
      safety,
      affectedRowCount: affectedRows,
    };
  }

  // Node 5: request_confirmation
  async function requestConfirmationNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    if (state.cancelReason) {
      // Already blocked by strict mode or generation error
      return { confirmed: false };
    }

    if (!state.generatedQuery || !state.safety) {
      return { confirmed: false, cancelReason: 'Missing query or safety classification.' };
    }

    const confirmHandler = config.confirmFn || requestUserConfirmation;
    const result = await confirmHandler(
      state.generatedQuery,
      state.safety,
      state.affectedRowCount ?? null
    );

    return {
      confirmed: result.confirmed,
      cancelReason: result.reason || (result.confirmed ? undefined : 'Execution cancelled by user.'),
    };
  }

  // Node 6: execute_query
  async function executeQueryNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    if (!state.confirmed || !state.generatedQuery) {
      return {};
    }

    const result = await adapter.executeQuery(state.generatedQuery);

    // If structural query succeeded, mark schema refresh for next turn
    const isStructuralSuccess = Boolean(state.safety?.isStructural && result.success);

    return {
      queryResult: result,
      requiresSchemaRefresh: isStructuralSuccess,
    };
  }

  // Node 7: analyze_results
  async function analyzeResultsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const res = state.queryResult;
    if (!res || !res.success || !res.rows || res.rows.length === 0) {
      return { stats: null };
    }

    // Compute basic statistics if rows have numeric columns
    const firstRow = res.rows[0];
    if (typeof firstRow !== 'object' || firstRow === null) {
      return { stats: null };
    }

    const numericFields = Object.keys(firstRow).filter((k) => {
      const val = firstRow[k];
      return typeof val === 'number' || (!isNaN(Number(val)) && typeof val === 'string' && val.trim() !== '');
    });

    const stats: Record<string, any> = {
      totalRows: res.rowCount ?? res.rows.length,
      columns: {},
    };

    for (const field of numericFields) {
      const nums = res.rows
        .map((r) => Number(r[field]))
        .filter((n) => !isNaN(n));
      if (nums.length > 0) {
        const sum = nums.reduce((a, b) => a + b, 0);
        const avg = sum / nums.length;
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        stats.columns[field] = {
          count: nums.length,
          sum,
          average: Math.round(avg * 100) / 100,
          min,
          max,
        };
      }
    }

    return { stats };
  }

  // Node 8: produce_conclusion
  async function produceConclusionNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    // If query was cancelled or blocked
    if (!state.confirmed || state.cancelReason) {
      const conclusion = state.cancelReason || 'Operation was not executed.';
      return {
        conclusion,
        messages: [new HumanMessage(state.userInput), new AIMessage(conclusion)],
      };
    }

    const res = state.queryResult;
    if (!res) {
      const conclusion = 'No query was executed.';
      return {
        conclusion,
        messages: [new HumanMessage(state.userInput), new AIMessage(conclusion)],
      };
    }

    if (!res.success) {
      const conclusion = `Query failed with error: ${res.error} (took ${res.durationMs}ms)`;
      return {
        conclusion,
        messages: [new HumanMessage(state.userInput), new AIMessage(conclusion)],
      };
    }

    const prompt = `User request: "${state.userInput}"
Executed Query:
${state.generatedQuery?.sql || state.generatedQuery?.rawDisplay}

Query Results Summary:
- Success: ${res.success}
- Rows returned: ${res.rowCount ?? 0}
- Affected rows: ${res.affectedRows ?? 0}
- Execution time: ${res.durationMs}ms
- Sample data: ${JSON.stringify((res.rows || []).slice(0, 10), null, 2)}
- Computed statistics: ${state.stats ? JSON.stringify(state.stats, null, 2) : 'None'}

Provide a clear, concise, and direct natural-language response answering the user's request.
Ground your response strictly in the query results above. Never hallucinate rows or numbers.`;

    try {
      const response = await model.invoke([new HumanMessage(prompt)]);
      const conclusion = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const queryStr = state.generatedQuery?.sql || state.generatedQuery?.rawDisplay;
      const historyAiText = queryStr ? `[Executed Query: ${queryStr}]\n${conclusion}` : conclusion;
      return {
        conclusion,
        messages: [new HumanMessage(state.userInput), new AIMessage(historyAiText)],
      };
    } catch (err: any) {
      const conclusion = `Query executed successfully (${res.rowCount ?? 0} rows, ${res.durationMs}ms).`;
      const queryStr = state.generatedQuery?.sql || state.generatedQuery?.rawDisplay;
      const historyAiText = queryStr ? `[Executed Query: ${queryStr}]\n${conclusion}` : conclusion;
      return {
        conclusion,
        messages: [new HumanMessage(state.userInput), new AIMessage(historyAiText)],
      };
    }
  }

  // Build the StateGraph
  const workflow = new StateGraph(AgentStateAnnotation)
    .addNode('inspect_schema', inspectSchemaNode)
    .addNode('identify_targets', identifyTargetsNode)
    .addNode('generate_query', generateQueryNode)
    .addNode('classify_safety', classifySafetyNode)
    .addNode('request_confirmation', requestConfirmationNode)
    .addNode('execute_query', executeQueryNode)
    .addNode('analyze_results', analyzeResultsNode)
    .addNode('produce_conclusion', produceConclusionNode)
    // Edges
    .addEdge(START, 'inspect_schema')
    .addEdge('inspect_schema', 'identify_targets')
    .addEdge('identify_targets', 'generate_query')
    .addEdge('generate_query', 'classify_safety')
    .addEdge('classify_safety', 'request_confirmation')
    .addConditionalEdges('request_confirmation', (state: AgentStateType) => {
      if (state.confirmed && !state.cancelReason) {
        return 'execute_query';
      }
      return 'produce_conclusion';
    })
    .addEdge('execute_query', 'analyze_results')
    .addEdge('analyze_results', 'produce_conclusion')
    .addEdge('produce_conclusion', END);

  const checkpointer = new MemorySaver();
  const app = workflow.compile({ checkpointer });

  return app;
}
