import { DatabaseType, ExecutableQuery } from '../db/adapter.js';

export type OperationCategory =
  | 'read'
  | 'write'
  | 'structural'
  | 'dangerous'
  | 'full_wipe'
  | 'admin';

export interface SafetyClassification {
  category: OperationCategory;
  isDestructive: boolean;
  isStructural: boolean;
  isFullWipe: boolean;
  isAdmin?: boolean;
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
      isAdmin: true,
      requiresLiteralWord: true,
      literalWord: 'DROP DATABASE',
      hasWhereClause: false,
      warnings: ['This operation permanently deletes an entire database or schema hierarchy.'],
      explanation: 'Permanently deletes database or schema cascade.',
    };
  }

  // 1b. DATABASE ADMIN TASKS
  // User and Role Management (CREATE/ALTER/DROP USER or ROLE)
  const isUserOrRole = /^(?:CREATE|ALTER|DROP)\s+(?:USER|ROLE)\b/i.test(cleanSql);
  if (isUserOrRole) {
    const isDrop = /^DROP\s+(?:USER|ROLE)\b/i.test(cleanSql);
    const isRole = /\bROLE\b/i.test(cleanSql);
    const word = isRole ? 'DROP ROLE' : 'DROP USER';
    return {
      category: 'admin',
      isDestructive: isDrop,
      isStructural: false,
      isFullWipe: false,
      isAdmin: true,
      requiresLiteralWord: isDrop,
      literalWord: isDrop ? word : undefined,
      hasWhereClause: false,
      warnings: isDrop
        ? ['Permanently deletes database credentials and associated privileges.']
        : [],
      explanation: `${isDrop ? 'Drops' : 'Manages'} database ${isRole ? 'role' : 'user'}.`,
    };
  }

  // Access Control & Privileges (GRANT, REVOKE)
  const isGrant = /^GRANT\s+/i.test(cleanSql);
  const isRevoke = /^REVOKE\s+/i.test(cleanSql);
  if (isGrant || isRevoke) {
    return {
      category: 'admin',
      isDestructive: false,
      isStructural: false,
      isFullWipe: false,
      isAdmin: true,
      requiresLiteralWord: false,
      hasWhereClause: false,
      warnings: isRevoke ? ['Revoking privileges modifies access control permissions.'] : [],
      explanation: isGrant ? 'Grants database privileges.' : 'Revokes database privileges.',
    };
  }

  // Database Maintenance (VACUUM, ANALYZE, REINDEX, CHECKPOINT)
  const isVacuum = /^VACUUM\b/i.test(cleanSql);
  const isAnalyze = /^ANALYZE\b/i.test(cleanSql);
  const isReindex = /^REINDEX\b/i.test(cleanSql);
  const isCheckpoint = /^CHECKPOINT\b/i.test(cleanSql);
  if (isVacuum || isAnalyze || isReindex || isCheckpoint) {
    const isVacuumFull = /^VACUUM\s+FULL\b/i.test(cleanSql);
    const maintenanceWarnings: string[] = [];
    if (isVacuumFull) {
      maintenanceWarnings.push(
        'VACUUM FULL exclusively locks tables and may cause operational downtime on active tables.'
      );
    }
    return {
      category: 'admin',
      isDestructive: false,
      isStructural: false,
      isFullWipe: false,
      isAdmin: true,
      requiresLiteralWord: false,
      hasWhereClause: false,
      warnings: maintenanceWarnings,
      explanation: isVacuum
        ? 'Performs database vacuum maintenance.'
        : isReindex
          ? 'Reindexes database tables or indexes.'
          : isAnalyze
            ? 'Collects database statistics for query planner.'
            : 'Forces a database checkpoint.',
    };
  }

  // Configuration Alteration (ALTER SYSTEM, ALTER DATABASE)
  const isAlterSystemOrDb = /^ALTER\s+(?:SYSTEM|DATABASE)\b/i.test(cleanSql);
  if (isAlterSystemOrDb) {
    return {
      category: 'admin',
      isDestructive: false,
      isStructural: false,
      isFullWipe: false,
      isAdmin: true,
      requiresLiteralWord: false,
      hasWhereClause: false,
      warnings: ['Alters database server or cluster configuration settings.'],
      explanation: 'Modifies database or system-level configuration.',
    };
  }

  // Backend Process Termination (pg_terminate_backend, pg_cancel_backend)
  const isKillBackend = /\bpg_(?:terminate|cancel)_backend\s*\(/i.test(cleanSql);
  if (isKillBackend) {
    return {
      category: 'admin',
      isDestructive: true,
      isStructural: false,
      isFullWipe: false,
      isAdmin: true,
      requiresLiteralWord: false,
      hasWhereClause: false,
      warnings: ['Terminates active database backend connection process.'],
      explanation: 'Terminates active backend query connection.',
    };
  }

  // 2. DANGEROUS OPS (checked before structural to prevent stacked statement bypass)
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

  const isDelete = /\bDELETE\s+FROM\b/i.test(cleanSql);
  if (isDelete) {
    const match = cleanSql.match(/DELETE\s+FROM\s+([^\s;(]+)(?:\s+WHERE\s+([\s\S]+?))?(?:;|$)/i);
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
  }

  const isUpdate = /\bUPDATE\s+[^\s;(]+\s+SET\b/i.test(cleanSql);
  if (isUpdate) {
    const match = cleanSql.match(/UPDATE\s+([^\s;(]+)\s+SET\s+[\s\S]+?(?:\s+WHERE\s+([\s\S]+?))?(?:;|$)/i);
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
  }

  // 3. STRUCTURAL OPS
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
    const tableMatches = [...cleanSql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s;(]+)/gi)].map((m) => m[1]);
    const hasInserts = /\bINSERT\s+INTO\b/i.test(cleanSql);
    const tableName = tableMatches[0] || 'unknown';
    const explanation = tableMatches.length > 1
      ? `Creates tables (${tableMatches.join(', ')})${hasInserts ? ' and populates seed data' : ''}.`
      : `Creates a new table "${tableName}"${hasInserts ? ' and populates seed data' : ''}.`;

    return {
      category: 'structural',
      isDestructive: false,
      isStructural: true,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: false,
      tableOrCollection: tableName,
      explanation,
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

  // 4. WRITE OPS
  if (isDelete) {
    const match = cleanSql.match(/DELETE\s+FROM\s+([^\s;(]+)(?:\s+WHERE\s+([\s\S]+?))?(?:;|$)/i);
    const tableName = match ? match[1] : undefined;
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

  if (isUpdate) {
    const match = cleanSql.match(/UPDATE\s+([^\s;(]+)\s+SET\s+[\s\S]+?(?:\s+WHERE\s+([\s\S]+?))?(?:;|$)/i);
    const tableName = match ? match[1] : undefined;
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

  const isInsert = /\bINSERT\s+INTO\b/i.test(cleanSql);
  if (isInsert) {
    const insertMatches = [...cleanSql.matchAll(/INSERT\s+INTO\s+([^\s;(]+)/gi)].map((m) => m[1]);
    const uniqueTables = [...new Set(insertMatches)];
    const tableName = uniqueTables[0] || 'unknown';
    const explanation = uniqueTables.length > 1
      ? `Inserts new records into tables (${uniqueTables.join(', ')}).`
      : `Inserts new records into table "${tableName}".`;

    return {
      category: 'write',
      isDestructive: false,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: false,
      tableOrCollection: tableName,
      explanation,
      warnings: [],
    };
  }

  // 5. READ (SELECT, EXPLAIN, SHOW, etc.)
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
  let operations = query.operations;

  if (!collectionName || !operation) {
    try {
      const parsed = JSON.parse(rawText);
      collectionName = parsed.collection || collectionName;
      operation = parsed.operation || operation;
      filter = parsed.filter || filter;
      operations = parsed.operations || operations;
    } catch {
      // not json
    }
  }

  // Multi-operation classification
  if (Array.isArray(operations) && operations.length > 0) {
    const subClassifications = operations.map((op) => {
      const display = typeof op === 'string' ? op : (op.rawDisplay || JSON.stringify(op));
      const opObj: ExecutableQuery =
        typeof op === 'object' && op !== null && op.rawDisplay
          ? (op as ExecutableQuery)
          : { ...op, rawDisplay: display };
      return classifyMongoQuery(display, opObj, rowThreshold, options);
    });

    const fullWipe = subClassifications.find((c) => c.isFullWipe);
    if (fullWipe) return fullWipe;

    const admin = subClassifications.find((c) => c.category === 'admin' || c.isAdmin);
    if (admin) return admin;

    const dangerous = subClassifications.find((c) => c.category === 'dangerous');
    if (dangerous) return dangerous;

    const structural = subClassifications.find((c) => c.category === 'structural');
    if (structural) return structural;

    const targetCols = [
      ...new Set(operations.map((o) => o.collection).filter(Boolean)),
    ];
    return {
      category: 'write',
      isDestructive: false,
      isStructural: false,
      isFullWipe: false,
      requiresLiteralWord: false,
      hasWhereClause: false,
      tableOrCollection: targetCols.join(', '),
      explanation: `Executes batch operations across collections (${targetCols.join(', ')}).`,
      warnings: [],
    };
  }

  const warnings: string[] = [];

  // 1. FULL WIPE: dropDatabase
  if (
    operation === 'dropDatabase' ||
    (operation === 'command' && (query.rawCommand?.dropDatabase || rawText.includes('dropDatabase')))
  ) {
    return {
      category: 'full_wipe',
      isDestructive: true,
      isStructural: false,
      isFullWipe: true,
      isAdmin: true,
      requiresLiteralWord: true,
      literalWord: 'DROP DATABASE',
      hasWhereClause: false,
      warnings: ['This operation permanently drops the entire MongoDB database.'],
      explanation: 'Drops the entire database.',
    };
  }

  // 1b. MONGO ADMIN OPERATIONS
  const isAdminCmd =
    operation === 'createUser' ||
    operation === 'dropUser' ||
    operation === 'grantRolesToUser' ||
    operation === 'revokeRolesFromUser' ||
    operation === 'repairDatabase' ||
    operation === 'compact' ||
    operation === 'reIndex' ||
    (operation === 'command' &&
      Boolean(
        query.rawCommand?.createUser ||
        query.rawCommand?.dropUser ||
        query.rawCommand?.grantRolesToUser ||
        query.rawCommand?.revokeRolesFromUser ||
        query.rawCommand?.repairDatabase ||
        query.rawCommand?.compact ||
        query.rawCommand?.reIndex ||
        query.rawCommand?.killOp ||
        query.rawCommand?.shutdown ||
        rawText.includes('createUser') ||
        rawText.includes('dropUser') ||
        rawText.includes('killOp') ||
        rawText.includes('repairDatabase')
      ));

  if (isAdminCmd) {
    const isDrop = operation === 'dropUser' || query.rawCommand?.dropUser || rawText.includes('dropUser');
    return {
      category: 'admin',
      isDestructive: isDrop,
      isStructural: false,
      isFullWipe: false,
      isAdmin: true,
      requiresLiteralWord: isDrop,
      literalWord: isDrop ? 'DROP USER' : undefined,
      hasWhereClause: false,
      tableOrCollection: collectionName,
      warnings: isDrop ? ['Permanently removes database user credentials and roles.'] : [],
      explanation: `Performs MongoDB administrative operation (${operation || 'command'}).`,
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
