import { DatabaseType, ExecutableQuery } from '../db/adapter.js';

export type OperationCategory =
  | 'read'
  | 'write'
  | 'structural'
  | 'dangerous'
  | 'full_wipe';

export interface SafetyClassification {
  category: OperationCategory;
  isDestructive: boolean;
  isStructural: boolean;
  isFullWipe: boolean;
  requiresLiteralWord: boolean;
  literalWord?: string;
  hasWhereClause: boolean;
  tableOrCollection?: string;
  explanation?: string;
  warnings: string[];
  suggestedAlternative?: string;
}

export interface ClassifierOptions {
  rowThresholdForDangerousUpdate?: number;
  strictMode?: boolean;
  allowFullWipe?: boolean;
}

const DEFAULT_DANGEROUS_UPDATE_THRESHOLD = 50;

/**
 * Classifies an executable query for safety, danger level, structural impact,
 * and whether a literal confirmation word is required.
 */
export function classifyQuery(
  query: ExecutableQuery,
  dbType: DatabaseType,
  options: ClassifierOptions = {}
): SafetyClassification {
  const rowThreshold = options.rowThresholdForDangerousUpdate ?? DEFAULT_DANGEROUS_UPDATE_THRESHOLD;
  const rawText = (query.sql || query.rawDisplay || '').trim();

  if (dbType === 'postgres') {
    return classifyPostgresQuery(rawText, query, rowThreshold, options);
  } else {
    return classifyMongoQuery(rawText, query, rowThreshold, options);
  }
}

function classifyPostgresQuery(
  sql: string,
  query: ExecutableQuery,
  rowThreshold: number,
  options: ClassifierOptions
): SafetyClassification {
  const cleanSql = sql.replace(/\/\*[\s\S]*?\*\/|--.*$/gm, '').trim();
  const upper = cleanSql.toUpperCase();
  const warnings: string[] = [];

  // 1. FULL WIPE DETECTION
  const isDropDb = /DROP\s+DATABASE/i.test(cleanSql);
  const isDropSchemaCascade = /DROP\s+SCHEMA\s+[\s\S]*?CASCADE/i.test(cleanSql);
  if (isDropDb || isDropSchemaCascade) {
    return {
      category: 'full_wipe',
      isDestructive: true,
      isStructural: false,
      isFullWipe: true,
      requiresLiteralWord: true,
      literalWord: 'DROP DATABASE',
      hasWhereClause: false,
      warnings: ['This operation permanently deletes an entire database or schema hierarchy.'],
      explanation: 'Permanently deletes database or schema cascade.',
    };
  }

  // 2. STRUCTURAL OPS
  // CREATE TABLE, CREATE SCHEMA, ALTER TABLE ADD COLUMN, CREATE INDEX, ADD CONSTRAINT
  const isCreateIndex = /CREATE\s+(UNIQUE\s+)?INDEX/i.test(cleanSql);
  const isCreateTable = /CREATE\s+TABLE/i.test(cleanSql);
  const isCreateSchema = /CREATE\s+SCHEMA/i.test(cleanSql);
  const isAlterAdd = /ALTER\s+TABLE\s+([^\s;]+)\s+ADD\s+(COLUMN|CONSTRAINT)/i.test(cleanSql);
  const isAlterOtherSafe = /ALTER\s+TABLE\s+([^\s;]+)\s+(ALTER\s+COLUMN|RENAME)/i.test(cleanSql);

  if (isCreateIndex) {
    const isConcurrently = /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(cleanSql);
    let suggestion: string | undefined;
    if (!isConcurrently) {
      warnings.push(
        'Index is not being created CONCURRENTLY. This will lock write operations on the table during index creation.'
      );
      suggestion = cleanSql.replace(/CREATE\s+(UNIQUE\s+)?INDEX/i, (m) => `${m} CONCURRENTLY`);
    }

    const tableMatch = cleanSql.match(/ON\s+([^\s;(]+)/i);
    const tableName = tableMatch ? tableMatch[1] : undefined;

    return {
      category: 'structural',
      isDestructive: false,
      isStructural: true,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: false,
      tableOrCollection: tableName,
      explanation: `Creates an index on ${tableName || 'table'}${isConcurrently ? ' concurrently (non-blocking)' : ' (may lock table during build)'}.`,
      warnings,
      suggestedAlternative: suggestion,
    };
  }

  if (isCreateTable) {
    const match = cleanSql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s;(]+)/i);
    const tableName = match ? match[1] : undefined;
    return {
      category: 'structural',
      isDestructive: false,
      isStructural: true,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: false,
      tableOrCollection: tableName,
      explanation: `Creates a new table "${tableName || 'unknown'}".`,
      warnings,
    };
  }

  if (isCreateSchema) {
    const match = cleanSql.match(/CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s;(]+)/i);
    const schemaName = match ? match[1] : undefined;
    return {
      category: 'structural',
      isDestructive: false,
      isStructural: true,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: false,
      tableOrCollection: schemaName,
      explanation: `Creates a new schema "${schemaName || 'unknown'}".`,
      warnings,
    };
  }

  if (isAlterAdd || isAlterOtherSafe) {
    const match = cleanSql.match(/ALTER\s+TABLE\s+([^\s;(]+)/i);
    const tableName = match ? match[1] : undefined;
    return {
      category: 'structural',
      isDestructive: false,
      isStructural: true,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: false,
      tableOrCollection: tableName,
      explanation: `Alters table "${tableName || 'unknown'}" to add or modify structural attributes.`,
      warnings,
    };
  }

  // 3. DESTRUCTURAL / ALTER DROP COLUMN
  const isAlterDrop = /ALTER\s+TABLE\s+([^\s;]+)\s+DROP\s+COLUMN/i.test(cleanSql);
  if (isAlterDrop) {
    const match = cleanSql.match(/ALTER\s+TABLE\s+([^\s;(]+)/i);
    const tableName = match ? match[1] : undefined;
    return {
      category: 'dangerous',
      isDestructive: true,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: false,
      tableOrCollection: tableName,
      explanation: `Removes a column from table "${tableName || 'unknown'}", permanently discarding column data.`,
      warnings: ['Removing a column is permanent and irreversible.'],
    };
  }

  // 4. DROP TABLE, DROP VIEW, TRUNCATE
  const isDropTable = /DROP\s+TABLE/i.test(cleanSql);
  const isTruncate = /TRUNCATE(\s+TABLE)?/i.test(cleanSql);
  if (isDropTable || isTruncate) {
    const match = cleanSql.match(/(?:DROP\s+TABLE|TRUNCATE(?:\s+TABLE)?)\s+(?:IF\s+EXISTS\s+)?([^\s;(]+)/i);
    const tableName = match ? match[1] : undefined;
    return {
      category: 'dangerous',
      isDestructive: true,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: true,
      literalWord: isDropTable ? 'DROP TABLE' : 'TRUNCATE',
      hasWhereClause: false,
      tableOrCollection: tableName,
      explanation: `Permanently removes all data from table "${tableName || 'unknown'}".`,
      warnings: ['All rows will be permanently deleted.'],
    };
  }

  // 5. DELETE
  const isDelete = /^DELETE\s+FROM/i.test(cleanSql);
  if (isDelete) {
    const match = cleanSql.match(/^DELETE\s+FROM\s+([^\s;(]+)(?:\s+WHERE\s+([\s\S]+))?/i);
    const tableName = match ? match[1] : undefined;
    const hasWhere = Boolean(match && match[2] && match[2].trim().length > 0);

    if (!hasWhere) {
      return {
        category: 'dangerous',
        isDestructive: true,
        isStructural: false,
        isFullWipe: false,
        requiresLiteralWord: true,
        literalWord: 'DELETE ALL',
        hasWhereClause: false,
        tableOrCollection: tableName,
        explanation: `Deletes ALL rows from table "${tableName || 'unknown'}" (no WHERE clause present).`,
        warnings: ['No WHERE clause specified: EVERY row in the table will be deleted!'],
      };
    }

    return {
      category: 'dangerous',
      isDestructive: true,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: true,
      tableOrCollection: tableName,
      explanation: `Deletes filtered rows from table "${tableName || 'unknown'}".`,
      warnings: ['Mutates existing database records.'],
    };
  }

  // 6. UPDATE
  const isUpdate = /^UPDATE\s+/i.test(cleanSql);
  if (isUpdate) {
    const match = cleanSql.match(/^UPDATE\s+([^\s;(]+)\s+SET\s+[\s\S]+?(?:\s+WHERE\s+([\s\S]+))?$/i);
    const tableName = match ? match[1] : undefined;
    const hasWhere = Boolean(match && match[2] && match[2].trim().length > 0);

    if (!hasWhere) {
      return {
        category: 'dangerous',
        isDestructive: true,
        isStructural: false,
        isFullWipe: false,
        requiresLiteralWord: true,
        literalWord: 'UPDATE ALL',
        hasWhereClause: false,
        tableOrCollection: tableName,
        explanation: `Updates ALL rows in table "${tableName || 'unknown'}" (no WHERE clause present).`,
        warnings: ['No WHERE clause specified: EVERY row in the table will be updated!'],
      };
    }

    return {
      category: 'write',
      isDestructive: false,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: true,
      tableOrCollection: tableName,
      explanation: `Updates filtered rows in table "${tableName || 'unknown'}".`,
      warnings: ['Mutates existing database records.'],
    };
  }

  // 7. INSERT
  const isInsert = /^INSERT\s+INTO/i.test(cleanSql);
  if (isInsert) {
    const match = cleanSql.match(/^INSERT\s+INTO\s+([^\s;(]+)/i);
    const tableName = match ? match[1] : undefined;
    return {
      category: 'write',
      isDestructive: false,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: false,
      tableOrCollection: tableName,
      explanation: `Inserts new records into table "${tableName || 'unknown'}".`,
      warnings: [],
    };
  }

  // 8. READ (SELECT, EXPLAIN, SHOW, etc.)
  if (/^(SELECT|EXPLAIN|SHOW|WITH)\b/i.test(cleanSql)) {
    return {
      category: 'read',
      isDestructive: false,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: /WHERE/i.test(cleanSql),
      explanation: 'Read-only query.',
      warnings: [],
    };
  }

  // Default fallback
  return {
    category: 'write',
    isDestructive: false,
    isStructural: false,
    isFullWipe: false,
    requiresLiteralWord: false,
    hasWhereClause: false,
    explanation: 'Database operation.',
    warnings: ['Non-standard query statement.'],
  };
}

function classifyMongoQuery(
  rawText: string,
  query: ExecutableQuery,
  rowThreshold: number,
  options: ClassifierOptions
): SafetyClassification {
  let collectionName = query.collection;
  let operation = query.operation;
  let filter = query.filter;

  if (!collectionName || !operation) {
    try {
      const parsed = JSON.parse(rawText);
      collectionName = parsed.collection || collectionName;
      operation = parsed.operation || operation;
      filter = parsed.filter || filter;
    } catch {
      // not json
    }
  }

  const warnings: string[] = [];

  // 1. FULL WIPE: dropDatabase
  if (operation === 'command' && (query.rawCommand?.dropDatabase || rawText.includes('dropDatabase'))) {
    return {
      category: 'full_wipe',
      isDestructive: true,
      isStructural: false,
      isFullWipe: true,
      requiresLiteralWord: true,
      literalWord: 'DROP DATABASE',
      hasWhereClause: false,
      warnings: ['This operation permanently drops the entire MongoDB database.'],
      explanation: 'Drops the entire database.',
    };
  }

  // 2. STRUCTURAL: createCollection, createIndex
  if (operation === 'createIndex') {
    const isBackground = query.options?.background === true;
    let suggestion: string | undefined;
    if (!isBackground) {
      warnings.push('Index is not specified with background: true. It may block other operations during build.');
    }
    return {
      category: 'structural',
      isDestructive: false,
      isStructural: true,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: false,
      tableOrCollection: collectionName,
      explanation: `Creates an index on collection "${collectionName || 'collection'}".`,
      warnings,
      suggestedAlternative: suggestion,
    };
  }

  if (operation === 'createCollection') {
    return {
      category: 'structural',
      isDestructive: false,
      isStructural: true,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: false,
      tableOrCollection: collectionName,
      explanation: `Creates collection "${collectionName}".`,
      warnings,
    };
  }

  // 3. DROP COLLECTION
  if (operation === 'drop') {
    return {
      category: 'dangerous',
      isDestructive: true,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: true,
      literalWord: 'DROP COLLECTION',
      hasWhereClause: false,
      tableOrCollection: collectionName,
      explanation: `Drops collection "${collectionName}", permanently deleting all documents and indexes.`,
      warnings: ['All documents in this collection will be removed.'],
    };
  }

  const hasFilter = filter && Object.keys(filter).length > 0;

  // 4. DELETE
  if (operation === 'deleteMany' || operation === 'deleteOne') {
    if (!hasFilter) {
      return {
        category: 'dangerous',
        isDestructive: true,
        isStructural: false,
        isFullWipe: false,
        requiresLiteralWord: true,
        literalWord: 'DELETE ALL',
        hasWhereClause: false,
        tableOrCollection: collectionName,
        explanation: `Deletes documents from "${collectionName}" with an empty filter (deletes all documents).`,
        warnings: ['No filter specified: all documents matching the empty filter will be deleted!'],
      };
    }
    return {
      category: 'dangerous',
      isDestructive: true,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: true,
      tableOrCollection: collectionName,
      explanation: `Deletes filtered documents from collection "${collectionName}".`,
      warnings: ['Mutates existing database documents.'],
    };
  }

  // 5. UPDATE
  if (operation === 'updateMany' || operation === 'updateOne') {
    if (!hasFilter) {
      return {
        category: 'dangerous',
        isDestructive: true,
        isStructural: false,
        isFullWipe: false,
        requiresLiteralWord: true,
        literalWord: 'UPDATE ALL',
        hasWhereClause: false,
        tableOrCollection: collectionName,
        explanation: `Updates documents in "${collectionName}" with an empty filter (updates all documents).`,
        warnings: ['No filter specified: every document in the collection will be updated!'],
      };
    }
    return {
      category: 'write',
      isDestructive: false,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: true,
      tableOrCollection: collectionName,
      explanation: `Updates documents in collection "${collectionName}".`,
      warnings: ['Mutates existing database documents.'],
    };
  }

  // 6. INSERT
  if (operation === 'insertOne' || operation === 'insertMany') {
    return {
      category: 'write',
      isDestructive: false,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: false,
      tableOrCollection: collectionName,
      explanation: `Inserts document(s) into collection "${collectionName}".`,
      warnings: [],
    };
  }

  // 7. READ: find, aggregate, countDocuments
  if (operation === 'find' || operation === 'aggregate' || operation === 'countDocuments') {
    return {
      category: 'read',
      isDestructive: false,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: Boolean(hasFilter),
      tableOrCollection: collectionName,
      explanation: 'Read-only operation.',
      warnings: [],
    };
  }

  return {
    category: 'read',
    isDestructive: false,
    isStructural: false,
    isFullWipe: false,
    requiresLiteralWord: false,
    hasWhereClause: false,
    explanation: 'Database operation.',
    warnings: [],
  };
}
