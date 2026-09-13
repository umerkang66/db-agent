import { describe, it, expect } from 'vitest';
import { detectDatabaseType, createDatabaseAdapter } from '../src/db/connection.js';
import { PostgresAdapter } from '../src/db/postgres.js';
import { MongoAdapter } from '../src/db/mongo.js';

describe('Database Connection Detection', () => {
  it('detects postgres URLs correctly', () => {
    expect(detectDatabaseType('postgres://user:pass@localhost:5432/mydb')).toBe('postgres');
    expect(detectDatabaseType('postgresql://user:pass@localhost:5432/mydb')).toBe('postgres');
    expect(detectDatabaseType('POSTGRESQL://localhost/mydb')).toBe('postgres');
  });

  it('detects mongodb URLs correctly', () => {
    expect(detectDatabaseType('mongodb://localhost:27017/mydb')).toBe('mongodb');
    expect(detectDatabaseType('mongodb+srv://user:pass@cluster0.mongodb.net/mydb')).toBe('mongodb');
    expect(detectDatabaseType('MONGODB://127.0.0.1/test')).toBe('mongodb');
  });

  it('throws error on unsupported scheme', () => {
    expect(() => detectDatabaseType('mysql://root:pass@localhost/db')).toThrow(/Unsupported database URL scheme/);
    expect(() => detectDatabaseType('redis://localhost:6379')).toThrow(/Unsupported database URL scheme/);
    expect(() => detectDatabaseType('sqlite:///data.db')).toThrow(/Unsupported database URL scheme/);
  });

  it('creates PostgresAdapter for postgres URLs', () => {
    const adapter = createDatabaseAdapter('postgresql://admin:supersecret@localhost:5432/production');
    expect(adapter).toBeInstanceOf(PostgresAdapter);
    expect(adapter.type).toBe('postgres');
    expect(adapter.databaseName).toBe('production');
    expect(adapter.getMaskedUrl()).not.toContain('supersecret');
    expect(adapter.getMaskedUrl()).toContain('***');
  });

  it('creates PostgresAdapter for Supabase URLs with auto-routing capability', () => {
    const adapter = createDatabaseAdapter('postgresql://postgres:pass@db.bgcfmmlrhmvoojuydhdj.supabase.co:5432/postgres') as PostgresAdapter;
    expect(adapter).toBeInstanceOf(PostgresAdapter);
    expect(adapter.type).toBe('postgres');
    expect(adapter.isSupabaseAutoRouted).toBe(false);
  });

  it('creates MongoAdapter for mongo URLs', () => {
    const adapter = createDatabaseAdapter('mongodb://admin:secretpass@cluster.net/analytics');
    expect(adapter).toBeInstanceOf(MongoAdapter);
    expect(adapter.type).toBe('mongodb');
    expect(adapter.databaseName).toBe('analytics');
    expect(adapter.getMaskedUrl()).not.toContain('secretpass');
  });
});
