import { DatabaseAdapter, DatabaseType } from './adapter.js';
import { PostgresAdapter } from './postgres.js';
import { MongoAdapter } from './mongo.js';

export function detectDatabaseType(url: string): DatabaseType {
  const trimmed = url.trim().toLowerCase();
  if (trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://')) {
    return 'postgres';
  }
  if (trimmed.startsWith('mongodb://') || trimmed.startsWith('mongodb+srv://')) {
    return 'mongodb';
  }
  throw new Error(
    `Unsupported database URL scheme. Expected postgres://, postgresql://, mongodb://, or mongodb+srv://. Received: ${url.slice(0, 15)}...`
  );
}

export function createDatabaseAdapter(url: string): DatabaseAdapter {
  const type = detectDatabaseType(url);
  if (type === 'postgres') {
    return new PostgresAdapter(url);
  }
  if (type === 'mongodb') {
    return new MongoAdapter(url);
  }
  throw new Error(`Unknown database type: ${type}`);
}
