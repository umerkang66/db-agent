import pg from 'pg';
import {
  DatabaseAdapter,
  DatabaseSchema,
  ExecutableQuery,
  QueryResult,
  TableSchema,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
} from './adapter.js';
import { maskUrl } from '../config/index.js';

const { Pool } = pg;

export class PostgresAdapter implements DatabaseAdapter {
  readonly type = 'postgres';
  private pool: pg.Pool | null = null;
  private connectionUrl: string;
  private cachedSchema: DatabaseSchema | null = null;
  public databaseName = 'postgres';

  constructor(connectionUrl: string) {
    this.connectionUrl = connectionUrl;
    try {
      const parsed = new URL(connectionUrl);
      this.databaseName = parsed.pathname.replace(/^\//, '') || 'postgres';
    } catch {
      this.databaseName = 'postgres';
    }
  }

  getMaskedUrl(): string {
    return maskUrl(this.connectionUrl);
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    this.pool = new Pool({
      connectionString: this.connectionUrl,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    });
    // Test the connection
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT current_database() as db_name;');
      if (res.rows[0]?.db_name) {
        this.databaseName = res.rows[0].db_name;
      }
    } finally {
      client.release();
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this.cachedSchema = null;
  }

  isConnected(): boolean {
    return this.pool !== null;
  }

  async inspectSchema(forceRefresh = false): Promise<DatabaseSchema> {
    if (this.cachedSchema && !forceRefresh) {
      return this.cachedSchema;
    }

    if (!this.pool) {
      await this.connect();
    }

    const client = await this.pool!.connect();
    try {
      // 1. Get all tables in public schema (or non-system schemas)
      const tablesResult = await client.query(`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_type = 'BASE TABLE'
        ORDER BY table_schema, table_name;
      `);

      // 2. Get all columns
      const columnsResult = await client.query(`
        SELECT 
          c.table_schema,
          c.table_name,
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT ku.table_schema, ku.table_name, ku.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name
            AND tc.table_schema = ku.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
        ) pk ON c.table_schema = pk.table_schema 
             AND c.table_name = pk.table_name 
             AND c.column_name = pk.column_name
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY c.table_schema, c.table_name, c.ordinal_position;
      `);

      // 3. Get indexes
      const indexesResult = await client.query(`
        SELECT
          schemaname as table_schema,
          tablename as table_name,
          indexname,
          indexdef
        FROM pg_indexes
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY schemaname, tablename, indexname;
      `);

      // 4. Get foreign keys
      const foreignKeysResult = await client.query(`
        SELECT
          tc.constraint_name,
          tc.table_schema,
          tc.table_name,
          kcu.column_name,
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema');
      `);

      // 5. Get approximate row counts
      const rowCountsResult = await client.query(`
        SELECT
          nspname AS table_schema,
          relname AS table_name,
          reltuples::bigint AS approx_row_count
        FROM pg_class C
        LEFT JOIN pg_namespace N ON (N.oid = C.relnamespace)
        WHERE nspname NOT IN ('pg_catalog', 'information_schema')
          AND relkind = 'r';
      `);

      const rowCountsMap = new Map<string, number>();
      for (const row of rowCountsResult.rows) {
        rowCountsMap.set(`${row.table_schema}.${row.table_name}`, Math.max(0, Number(row.approx_row_count)));
      }

      // Group columns by table
      const columnsMap = new Map<string, ColumnInfo[]>();
      for (const row of columnsResult.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        const list = columnsMap.get(key) || [];
        list.push({
          name: row.column_name,
          dataType: row.data_type,
          isNullable: row.is_nullable === 'YES',
          defaultValue: row.column_default,
          isPrimaryKey: Boolean(row.is_primary_key),
        });
        columnsMap.set(key, list);
      }

      // Group indexes by table
      const indexesMap = new Map<string, IndexInfo[]>();
      for (const row of indexesResult.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        const list = indexesMap.get(key) || [];
        const isUnique = /create\s+unique\s+index/i.test(row.indexdef);
        const isPrimary = /_pkey$/i.test(row.indexname) || /primary key/i.test(row.indexdef);
        list.push({
          name: row.indexname,
          tableName: row.table_name,
          columnNames: [], // extracted from indexdef
          isUnique,
          isPrimary,
          definition: row.indexdef,
        });
        indexesMap.set(key, list);
      }

      // Group foreign keys by table
      const foreignKeysMap = new Map<string, ForeignKeyInfo[]>();
      for (const row of foreignKeysResult.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        const list = foreignKeysMap.get(key) || [];
        list.push({
          constraintName: row.constraint_name,
          columnName: row.column_name,
          foreignTableName: row.foreign_table_name,
          foreignColumnName: row.foreign_column_name,
        });
        foreignKeysMap.set(key, list);
      }

      const tables: TableSchema[] = tablesResult.rows.map((r: any) => {
        const key = `${r.table_schema}.${r.table_name}`;
        return {
          name: r.table_name,
          schema: r.table_schema,
          columns: columnsMap.get(key) || [],
          indexes: indexesMap.get(key) || [],
          foreignKeys: foreignKeysMap.get(key) || [],
          approximateRowCount: rowCountsMap.get(key) ?? 0,
        };
      });

      this.cachedSchema = {
        type: 'postgres',
        databaseName: this.databaseName,
        tables,
        inspectedAt: new Date(),
      };

      return this.cachedSchema;
    } finally {
      client.release();
    }
  }

  async executeQuery(query: ExecutableQuery): Promise<QueryResult> {
    if (!this.pool) {
      await this.connect();
    }

    const sql = query.sql || query.rawDisplay;
    const startTime = Date.now();

    const client = await this.pool!.connect();
    try {
      const res = await client.query(sql, query.params || []);
      const durationMs = Date.now() - startTime;

      let rows: any[] = [];
      let fields: string[] = [];
      let rowCount = 0;

      if (Array.isArray(res)) {
        // Multi-statement query result
        const lastResult = res[res.length - 1];
        rows = lastResult?.rows || [];
        fields = (lastResult?.fields || []).map((f: any) => f.name);
        rowCount = lastResult?.rowCount ?? rows.length;
      } else if (res) {
        rows = res.rows || [];
        fields = (res.fields || []).map((f: any) => f.name);
        rowCount = res.rowCount ?? rows.length;
      }

      return {
        success: true,
        rows,
        fields,
        rowCount,
        affectedRows: rowCount,
        durationMs,
        command: Array.isArray(res) ? res[res.length - 1]?.command : res?.command,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      return {
        success: false,
        durationMs,
        error: err.message || String(err),
      };
    } finally {
      client.release();
    }
  }

  async dryRunCount(query: ExecutableQuery): Promise<number | null> {
    if (!this.pool) {
      await this.connect();
    }

    const sql = (query.sql || query.rawDisplay).trim();

    // 1. Check for DELETE FROM <table> [WHERE ...]
    const deleteMatch = sql.match(/^DELETE\s+FROM\s+([^\s;()]+)(?:\s+WHERE\s+([\s\S]+?))?(?:;)?$/i);
    if (deleteMatch) {
      const table = deleteMatch[1];
      const whereClause = deleteMatch[2];
      const countSql = whereClause
        ? `SELECT COUNT(*) as count FROM ${table} WHERE ${whereClause}`
        : `SELECT COUNT(*) as count FROM ${table}`;
      try {
        const client = await this.pool!.connect();
        try {
          const res = await client.query(countSql, query.params || []);
          return Number(res.rows[0]?.count ?? 0);
        } finally {
          client.release();
        }
      } catch {
        return null;
      }
    }

    // 2. Check for UPDATE <table> SET ... [WHERE ...]
    const updateMatch = sql.match(/^UPDATE\s+([^\s;()]+)\s+SET\s+[\s\S]+?(?:\s+WHERE\s+([\s\S]+?))?(?:;)?$/i);
    if (updateMatch) {
      const table = updateMatch[1];
      const whereClause = updateMatch[2];
      const countSql = whereClause
        ? `SELECT COUNT(*) as count FROM ${table} WHERE ${whereClause}`
        : `SELECT COUNT(*) as count FROM ${table}`;
      try {
        const client = await this.pool!.connect();
        try {
          const res = await client.query(countSql);
          return Number(res.rows[0]?.count ?? 0);
        } finally {
          client.release();
        }
      } catch {
        return null;
      }
    }

    // 3. Check for TRUNCATE [TABLE] <table> or DROP TABLE <table>
    const truncateOrDropMatch = sql.match(/^(?:TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+([^\s;()]+)/i);
    if (truncateOrDropMatch) {
      const table = truncateOrDropMatch[1];
      try {
        const client = await this.pool!.connect();
        try {
          const res = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
          return Number(res.rows[0]?.count ?? 0);
        } finally {
          client.release();
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  async explainQuery(query: ExecutableQuery): Promise<string> {
    if (!this.pool) {
      await this.connect();
    }

    const sql = (query.sql || query.rawDisplay).trim();
    // Only explain SELECT, UPDATE, DELETE, INSERT
    if (!/^(SELECT|UPDATE|DELETE|INSERT)/i.test(sql)) {
      return '';
    }

    const client = await this.pool!.connect();
    try {
      const res = await client.query(`EXPLAIN ${sql}`, query.params || []);
      return res.rows.map((r: any) => Object.values(r)[0]).join('\n');
    } catch (err: any) {
      return `Explain failed: ${err.message}`;
    } finally {
      client.release();
    }
  }
}
