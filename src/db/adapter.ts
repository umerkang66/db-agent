export type DatabaseType = 'postgres' | 'mongodb';

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey?: boolean;
}

export interface IndexInfo {
  name: string;
  tableName: string;
  columnNames: string[];
  isUnique: boolean;
  isPrimary: boolean;
  definition?: string;
}

export interface ForeignKeyInfo {
  constraintName: string;
  columnName: string;
  foreignTableName: string;
  foreignColumnName: string;
}

export interface TableSchema {
  name: string;
  schema: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  approximateRowCount?: number;
}

export interface CollectionFieldInfo {
  name: string;
  types: string[]; // inferred from sampled docs, e.g. ['string', 'number']
  required?: boolean;
  sampleValue?: any;
}

export interface CollectionSchema {
  name: string;
  fields: CollectionFieldInfo[];
  indexes: IndexInfo[];
  documentCount?: number;
  sampleDocument?: Record<string, any>;
}

export interface DatabaseSchema {
  type: DatabaseType;
  databaseName: string;
  tables?: TableSchema[]; // for Postgres
  collections?: CollectionSchema[]; // for Mongo
  inspectedAt: Date;
}

export interface ExecutableQuery {
  // For SQL (Postgres):
  sql?: string;
  params?: any[];

  // For Mongo:
  collection?: string;
  operation?:
    | 'find'
    | 'aggregate'
    | 'countDocuments'
    | 'insertOne'
    | 'insertMany'
    | 'updateOne'
    | 'updateMany'
    | 'deleteOne'
    | 'deleteMany'
    | 'drop'
    | 'dropDatabase'
    | 'createIndex'
    | 'createCollection'
    | 'createUser'
    | 'dropUser'
    | 'grantRolesToUser'
    | 'revokeRolesFromUser'
    | 'repairDatabase'
    | 'compact'
    | 'reIndex'
    | 'command'
    | (string & {});
  filter?: Record<string, any>;
  update?: Record<string, any>;
  pipeline?: Record<string, any>[];
  document?: Record<string, any>;
  documents?: Record<string, any>[];
  options?: Record<string, any>;
  rawCommand?: Record<string, any>;
  operations?: Array<Record<string, any>>;

  // Raw display string representation (SQL query or JSON command string)
  rawDisplay: string;
}

export interface QueryResult {
  success: boolean;
  rows?: any[];
  rowCount?: number;
  fields?: string[];
  durationMs: number;
  affectedRows?: number;
  error?: string;
  command?: string;
  rawOutput?: any;
}

export interface DatabaseAdapter {
  readonly type: DatabaseType;
  readonly databaseName: string;
  readonly connectionUrl: string;
  connect(onProgress?: (status: string) => void): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  inspectSchema(forceRefresh?: boolean): Promise<DatabaseSchema>;
  executeQuery(query: ExecutableQuery): Promise<QueryResult>;
  dryRunCount(query: ExecutableQuery): Promise<number | null>;
  explainQuery(query: ExecutableQuery): Promise<string>;
  getMaskedUrl(): string;
}
