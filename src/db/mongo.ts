import { MongoClient, Db } from 'mongodb';
import {
  DatabaseAdapter,
  DatabaseSchema,
  ExecutableQuery,
  QueryResult,
  CollectionSchema,
  CollectionFieldInfo,
  IndexInfo,
} from './adapter.js';
import { maskUrl } from '../config/index.js';

export class MongoAdapter implements DatabaseAdapter {
  readonly type = 'mongodb';
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private connectionUrl: string;
  private cachedSchema: DatabaseSchema | null = null;
  public databaseName = 'admin';

  constructor(connectionUrl: string) {
    this.connectionUrl = connectionUrl;
    try {
      const parsed = new URL(connectionUrl);
      const dbName = parsed.pathname.replace(/^\//, '');
      if (dbName) {
        this.databaseName = dbName;
      }
    } catch {
      // Fallback
    }
  }

  getMaskedUrl(): string {
    return maskUrl(this.connectionUrl);
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.client = new MongoClient(this.connectionUrl, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
    await this.client.connect();
    this.db = this.client.db(this.databaseName === 'admin' ? undefined : this.databaseName);
    this.databaseName = this.db.databaseName;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
    this.cachedSchema = null;
  }

  isConnected(): boolean {
    return this.client !== null && this.db !== null;
  }

  async inspectSchema(forceRefresh = false): Promise<DatabaseSchema> {
    if (this.cachedSchema && !forceRefresh) {
      return this.cachedSchema;
    }

    if (!this.isConnected()) {
      await this.connect();
    }

    const db = this.db!;
    const collectionsList = await db.listCollections().toArray();
    const collectionSchemas: CollectionSchema[] = [];

    for (const colInfo of collectionsList) {
      const colName = colInfo.name;
      if (colName.startsWith('system.')) continue;

      const collection = db.collection(colName);

      // 1. Get document count
      let documentCount = 0;
      try {
        documentCount = await collection.estimatedDocumentCount();
      } catch {
        // collection might be a view or empty
      }

      // 2. Sample up to 20 documents to infer fields and types
      const sampleDocs = await collection.find({}).limit(20).toArray();
      const fieldMap = new Map<string, Set<string>>();
      let sampleDoc: Record<string, any> | undefined = sampleDocs[0];

      for (const doc of sampleDocs) {
        this.extractFields(doc, '', fieldMap);
      }

      const fields: CollectionFieldInfo[] = Array.from(fieldMap.entries()).map(([name, types]) => ({
        name,
        types: Array.from(types),
      }));

      // 3. Get indexes
      let indexes: IndexInfo[] = [];
      try {
        const rawIndexes = await collection.indexes();
        indexes = rawIndexes.map((idx) => ({
          name: idx.name || 'unknown',
          tableName: colName,
          columnNames: Object.keys(idx.key || {}),
          isUnique: Boolean(idx.unique),
          isPrimary: idx.name === '_id_',
          definition: JSON.stringify(idx.key),
        }));
      } catch {
        // ignore index fetch error
      }

      collectionSchemas.push({
        name: colName,
        fields,
        indexes,
        documentCount,
        sampleDocument: sampleDoc,
      });
    }

    this.cachedSchema = {
      type: 'mongodb',
      databaseName: this.databaseName,
      collections: collectionSchemas,
      inspectedAt: new Date(),
    };

    return this.cachedSchema;
  }

  private extractFields(obj: any, prefix: string, fieldMap: Map<string, Set<string>>): void {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj instanceof Date) {
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      let type: string = typeof value;
      if (value === null) type = 'null';
      else if (Array.isArray(value)) type = 'array';
      else if (value instanceof Date) type = 'date';
      else if (value && typeof value === 'object' && (value as any)._bsontype) type = (value as any)._bsontype;

      if (!fieldMap.has(fullKey)) {
        fieldMap.set(fullKey, new Set());
      }
      fieldMap.get(fullKey)!.add(type);

      if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value as any)._bsontype) {
        this.extractFields(value, fullKey, fieldMap);
      }
    }
  }

  async executeQuery(query: ExecutableQuery): Promise<QueryResult> {
    if (!this.isConnected()) {
      await this.connect();
    }

    const startTime = Date.now();
    const db = this.db!;

    try {
      // 1. If rawCommand is provided or raw JSON command
      if (query.operation === 'command' || query.rawCommand) {
        const cmd = query.rawCommand || (typeof query.rawDisplay === 'string' ? JSON.parse(query.rawDisplay) : query.rawDisplay);
        const result = await db.command(cmd);
        const durationMs = Date.now() - startTime;
        return {
          success: true,
          durationMs,
          rawOutput: result,
          rowCount: 1,
          rows: [result],
        };
      }

      // 2. Parse from query properties or try parsing JSON display
      let collectionName = query.collection;
      let operation = query.operation;
      let filter = query.filter || {};
      let update = query.update || {};
      let pipeline = query.pipeline || [];
      let document = query.document;
      let documents = query.documents;
      let options = query.options || {};

      if (!collectionName || !operation) {
        // Attempt to parse rawDisplay if structured JSON
        try {
          const parsed = JSON.parse(query.rawDisplay);
          collectionName = parsed.collection || collectionName;
          operation = parsed.operation || operation;
          filter = parsed.filter || filter;
          update = parsed.update || update;
          pipeline = parsed.pipeline || pipeline;
          document = parsed.document || document;
          documents = parsed.documents || documents;
          options = parsed.options || options;
        } catch {
          // not JSON, keep defaults
        }
      }

      if (!collectionName) {
        throw new Error('Mongo operation requires a target collection.');
      }

      const collection = db.collection(collectionName);
      let rows: any[] = [];
      let rowCount = 0;
      let affectedRows = 0;

      switch (operation) {
        case 'find': {
          const limit = options.limit || 100;
          const cursor = collection.find(filter, options).limit(limit);
          rows = await cursor.toArray();
          rowCount = rows.length;
          break;
        }
        case 'aggregate': {
          const cursor = collection.aggregate(pipeline, options);
          rows = await cursor.toArray();
          rowCount = rows.length;
          break;
        }
        case 'countDocuments': {
          const count = await collection.countDocuments(filter, options);
          rows = [{ count }];
          rowCount = 1;
          break;
        }
        case 'insertOne': {
          const res = await collection.insertOne(document || filter, options);
          rows = [{ insertedId: res.insertedId, acknowledged: res.acknowledged }];
          rowCount = 1;
          affectedRows = 1;
          break;
        }
        case 'insertMany': {
          const docs = documents || (Array.isArray(document) ? document : [document]);
          const res = await collection.insertMany(docs, options);
          rows = [{ insertedCount: res.insertedCount, acknowledged: res.acknowledged }];
          rowCount = res.insertedCount;
          affectedRows = res.insertedCount;
          break;
        }
        case 'updateOne': {
          const res = await collection.updateOne(filter, update, options);
          rows = [{ matchedCount: res.matchedCount, modifiedCount: res.modifiedCount, upsertedId: res.upsertedId }];
          rowCount = res.modifiedCount;
          affectedRows = res.modifiedCount;
          break;
        }
        case 'updateMany': {
          const res = await collection.updateMany(filter, update, options);
          rows = [{ matchedCount: res.matchedCount, modifiedCount: res.modifiedCount, upsertedId: res.upsertedId }];
          rowCount = res.modifiedCount;
          affectedRows = res.modifiedCount;
          break;
        }
        case 'deleteOne': {
          const res = await collection.deleteOne(filter, options);
          rows = [{ deletedCount: res.deletedCount }];
          rowCount = res.deletedCount;
          affectedRows = res.deletedCount;
          break;
        }
        case 'deleteMany': {
          const res = await collection.deleteMany(filter, options);
          rows = [{ deletedCount: res.deletedCount }];
          rowCount = res.deletedCount;
          affectedRows = res.deletedCount;
          break;
        }
        case 'drop': {
          const res = await collection.drop();
          rows = [{ dropped: res }];
          rowCount = res ? 1 : 0;
          break;
        }
        case 'createIndex': {
          const keys = options.keys || filter;
          const indexOptions = options.indexOptions || {};
          const indexName = await collection.createIndex(keys, indexOptions);
          rows = [{ createdIndex: indexName }];
          rowCount = 1;
          break;
        }
        case 'createCollection': {
          await db.createCollection(collectionName, options);
          rows = [{ createdCollection: collectionName }];
          rowCount = 1;
          break;
        }
        default:
          throw new Error(`Unsupported MongoDB operation: ${operation}`);
      }

      const durationMs = Date.now() - startTime;
      const fields = rows.length > 0 && typeof rows[0] === 'object' ? Object.keys(rows[0]) : [];

      return {
        success: true,
        rows,
        rowCount,
        affectedRows,
        fields,
        durationMs,
        command: operation,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      return {
        success: false,
        durationMs,
        error: err.message || String(err),
      };
    }
  }

  async dryRunCount(query: ExecutableQuery): Promise<number | null> {
    if (!this.isConnected()) {
      await this.connect();
    }

    try {
      let collectionName = query.collection;
      let operation = query.operation;
      let filter = query.filter || {};

      if (!collectionName || !operation) {
        try {
          const parsed = JSON.parse(query.rawDisplay);
          collectionName = parsed.collection || collectionName;
          operation = parsed.operation || operation;
          filter = parsed.filter || filter;
        } catch {
          // ignore
        }
      }

      if (!collectionName) return null;

      const collection = this.db!.collection(collectionName);

      if (operation === 'deleteOne') {
        const count = await collection.countDocuments(filter);
        return Math.min(1, count);
      }

      if (operation === 'deleteMany' || operation === 'updateOne' || operation === 'updateMany') {
        return await collection.countDocuments(filter);
      }

      if (operation === 'drop') {
        return await collection.estimatedDocumentCount();
      }

      return null;
    } catch {
      return null;
    }
  }

  async explainQuery(query: ExecutableQuery): Promise<string> {
    if (!this.isConnected()) {
      await this.connect();
    }

    try {
      let collectionName = query.collection;
      let operation = query.operation || 'find';
      let filter = query.filter || {};
      let pipeline = query.pipeline || [];

      if (!collectionName) {
        try {
          const parsed = JSON.parse(query.rawDisplay);
          collectionName = parsed.collection || collectionName;
          operation = parsed.operation || operation;
          filter = parsed.filter || filter;
          pipeline = parsed.pipeline || pipeline;
        } catch {
          return '';
        }
      }

      if (!collectionName) return '';
      const collection = this.db!.collection(collectionName);

      if (operation === 'find') {
        const explanation = await collection.find(filter).explain('executionStats');
        return JSON.stringify(explanation, null, 2);
      }

      if (operation === 'aggregate') {
        const explanation = await collection.aggregate(pipeline).explain('executionStats');
        return JSON.stringify(explanation, null, 2);
      }

      return '';
    } catch (err: any) {
      return `Explain failed: ${err.message}`;
    }
  }
}
