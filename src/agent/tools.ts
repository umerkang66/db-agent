import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { DatabaseAdapter, ExecutableQuery, QueryResult } from '../db/adapter.js';
import { formatSchemaForPrompt } from './prompts.js';

export function createDatabaseTools(adapter: DatabaseAdapter) {
  const inspectSchemaTool = tool(
    async ({ refresh }: { refresh?: boolean }) => {
      const schema = await adapter.inspectSchema(refresh);
      return formatSchemaForPrompt(schema);
    },
    {
      name: 'inspectSchema',
      description: 'Introspects tables/collections, columns/fields, types, indexes, and foreign keys of the connected database.',
      schema: z.object({
        refresh: z.boolean().optional().describe('Force refresh cached schema if structural changes were made'),
      }),
    }
  );

  const executeQueryTool = tool(
    async ({ query }: { query: string }) => {
      const execQuery: ExecutableQuery =
        adapter.type === 'postgres'
          ? { sql: query, rawDisplay: query }
          : { rawDisplay: query };
      const result: QueryResult = await adapter.executeQuery(execQuery);
      if (!result.success) {
        return JSON.stringify({ error: result.error, durationMs: result.durationMs });
      }
      return JSON.stringify({
        rowCount: result.rowCount,
        affectedRows: result.affectedRows,
        fields: result.fields,
        rows: (result.rows || []).slice(0, 50), // cap preview for LLM context
        durationMs: result.durationMs,
      });
    },
    {
      name: 'executeQuery',
      description: 'Executes confirmed SQL or Mongo query against the database.',
      schema: z.object({
        query: z.string().describe('The SQL statement or MongoDB JSON command to execute'),
      }),
    }
  );

  const calculateStatsTool = tool(
    async ({ data, numericFields }: { data: Record<string, any>[]; numericFields?: string[] }) => {
      if (!data || data.length === 0) {
        return JSON.stringify({ message: 'No data provided to calculate stats' });
      }

      const fieldsToAnalyze = numericFields || Object.keys(data[0]).filter((k) => typeof data[0][k] === 'number');

      const stats: Record<string, any> = {
        totalRows: data.length,
        columns: {},
      };

      for (const field of fieldsToAnalyze) {
        const values = data.map((d) => d[field]).filter((v) => typeof v === 'number' && !isNaN(v));
        if (values.length === 0) continue;

        const sum = values.reduce((a, b) => a + b, 0);
        const avg = sum / values.length;
        const min = Math.min(...values);
        const max = Math.max(...values);

        // Standard deviation
        const squareDiffs = values.map((value) => Math.pow(value - avg, 2));
        const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
        const stdDev = Math.sqrt(avgSquareDiff);

        stats.columns[field] = {
          count: values.length,
          sum,
          average: Math.round(avg * 100) / 100,
          min,
          max,
          stdDev: Math.round(stdDev * 100) / 100,
        };
      }

      return JSON.stringify(stats, null, 2);
    },
    {
      name: 'calculateStats',
      description: 'Calculates summary statistics (count, sum, average, min, max, stdDev) on row data.',
      schema: z.object({
        data: z.array(z.record(z.any())).describe('Array of row objects to compute statistics on'),
        numericFields: z.array(z.string()).optional().describe('Optional list of numeric field names to calculate stats for'),
      }),
    }
  );

  return {
    inspectSchemaTool,
    executeQueryTool,
    calculateStatsTool,
  };
}
