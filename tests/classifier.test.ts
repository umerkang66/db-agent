import { describe, it, expect } from 'vitest';
import { classifyQuery } from '../src/safety/classifier.js';
import { checkStrictWipe, classifyIntent, isExplicitNoQuery, REFUSAL_MESSAGE } from '../src/agent/guardrails.js';

describe('Safety Classifier - PostgreSQL', () => {
  it('classifies SELECT queries as read-only', () => {
    const res = classifyQuery({ sql: 'SELECT * FROM users WHERE active = true;', rawDisplay: 'SELECT * FROM users WHERE active = true;' }, 'postgres');
    expect(res.category).toBe('read');
    expect(res.isDestructive).toBe(false);
    expect(res.isStructural).toBe(false);
    expect(res.requiresLiteralWord).toBe(false);
  });

  it('classifies DELETE with WHERE as dangerous but not requiring literal word', () => {
    const res = classifyQuery({
      sql: "DELETE FROM users WHERE last_login < '2024-09-13';",
      rawDisplay: "DELETE FROM users WHERE last_login < '2024-09-13';",
    }, 'postgres');

    expect(res.category).toBe('dangerous');
    expect(res.isDestructive).toBe(true);
    expect(res.hasWhereClause).toBe(true);
    expect(res.requiresLiteralWord).toBe(false);
  });

  it('classifies DELETE without WHERE as requiring literal confirmation word "DELETE ALL"', () => {
    const res = classifyQuery({
      sql: 'DELETE FROM users;',
      rawDisplay: 'DELETE FROM users;',
    }, 'postgres');

    expect(res.category).toBe('dangerous');
    expect(res.isDestructive).toBe(true);
    expect(res.hasWhereClause).toBe(false);
    expect(res.requiresLiteralWord).toBe(true);
    expect(res.literalWord).toBe('DELETE ALL');
  });

  it('classifies UPDATE with WHERE as write operation', () => {
    const res = classifyQuery({
      sql: "UPDATE users SET status = 'active' WHERE id = 123;",
      rawDisplay: "UPDATE users SET status = 'active' WHERE id = 123;",
    }, 'postgres');

    expect(res.category).toBe('write');
    expect(res.isDestructive).toBe(false);
    expect(res.hasWhereClause).toBe(true);
    expect(res.requiresLiteralWord).toBe(false);
  });

  it('classifies UPDATE without WHERE as requiring literal confirmation word "UPDATE ALL"', () => {
    const res = classifyQuery({
      sql: "UPDATE users SET status = 'inactive';",
      rawDisplay: "UPDATE users SET status = 'inactive';",
    }, 'postgres');

    expect(res.category).toBe('dangerous');
    expect(res.isDestructive).toBe(true);
    expect(res.hasWhereClause).toBe(false);
    expect(res.requiresLiteralWord).toBe(true);
    expect(res.literalWord).toBe('UPDATE ALL');
  });

  it('classifies DROP TABLE and TRUNCATE as dangerous requiring literal word', () => {
    const dropRes = classifyQuery({ sql: 'DROP TABLE legacy_users;', rawDisplay: 'DROP TABLE legacy_users;' }, 'postgres');
    expect(dropRes.category).toBe('dangerous');
    expect(dropRes.requiresLiteralWord).toBe(true);
    expect(dropRes.literalWord).toBe('DROP TABLE');

    const truncRes = classifyQuery({ sql: 'TRUNCATE TABLE logs;', rawDisplay: 'TRUNCATE TABLE logs;' }, 'postgres');
    expect(truncRes.category).toBe('dangerous');
    expect(truncRes.requiresLiteralWord).toBe(true);
    expect(truncRes.literalWord).toBe('TRUNCATE');
  });

  it('classifies DROP DATABASE as full_wipe requiring literal confirmation word', () => {
    const res = classifyQuery({ sql: 'DROP DATABASE production;', rawDisplay: 'DROP DATABASE production;' }, 'postgres');
    expect(res.category).toBe('full_wipe');
    expect(res.isFullWipe).toBe(true);
    expect(res.requiresLiteralWord).toBe(true);
    expect(res.literalWord).toBe('DROP DATABASE');
  });

  it('classifies CREATE TABLE as structural DDL', () => {
    const res = classifyQuery({
      sql: 'CREATE TABLE orders (id SERIAL PRIMARY KEY, total NUMERIC);',
      rawDisplay: 'CREATE TABLE orders (id SERIAL PRIMARY KEY, total NUMERIC);',
    }, 'postgres');

    expect(res.category).toBe('structural');
    expect(res.isStructural).toBe(true);
    expect(res.isDestructive).toBe(false);
    expect(res.requiresLiteralWord).toBe(false);
  });

  it('warns when CREATE INDEX is not CONCURRENTLY and suggests alternative', () => {
    const res = classifyQuery({
      sql: 'CREATE INDEX idx_users_email ON users (email);',
      rawDisplay: 'CREATE INDEX idx_users_email ON users (email);',
    }, 'postgres');

    expect(res.category).toBe('structural');
    expect(res.isStructural).toBe(true);
    expect(res.warnings.some((w) => w.includes('CONCURRENTLY'))).toBe(true);
    expect(res.suggestedAlternative).toContain('CONCURRENTLY');
  });

  it('does not warn when CREATE INDEX CONCURRENTLY is used', () => {
    const res = classifyQuery({
      sql: 'CREATE INDEX CONCURRENTLY idx_users_email ON users (email);',
      rawDisplay: 'CREATE INDEX CONCURRENTLY idx_users_email ON users (email);',
    }, 'postgres');

    expect(res.category).toBe('structural');
    expect(res.isStructural).toBe(true);
    expect(res.warnings.some((w) => w.includes('CONCURRENTLY'))).toBe(false);
  });
});

describe('Safety Classifier - MongoDB', () => {
  it('classifies find and aggregate as read-only', () => {
    const findRes = classifyQuery({
      collection: 'users',
      operation: 'find',
      filter: { active: true },
      rawDisplay: JSON.stringify({ collection: 'users', operation: 'find', filter: { active: true } }),
    }, 'mongodb');

    expect(findRes.category).toBe('read');
    expect(findRes.isDestructive).toBe(false);
  });

  it('classifies deleteMany with filter as dangerous', () => {
    const res = classifyQuery({
      collection: 'users',
      operation: 'deleteMany',
      filter: { status: 'banned' },
      rawDisplay: JSON.stringify({ collection: 'users', operation: 'deleteMany', filter: { status: 'banned' } }),
    }, 'mongodb');

    expect(res.category).toBe('dangerous');
    expect(res.requiresLiteralWord).toBe(false);
    expect(res.hasWhereClause).toBe(true);
  });

  it('classifies deleteMany without filter as dangerous requiring literal word "DELETE ALL"', () => {
    const res = classifyQuery({
      collection: 'users',
      operation: 'deleteMany',
      filter: {},
      rawDisplay: JSON.stringify({ collection: 'users', operation: 'deleteMany', filter: {} }),
    }, 'mongodb');

    expect(res.category).toBe('dangerous');
    expect(res.requiresLiteralWord).toBe(true);
    expect(res.literalWord).toBe('DELETE ALL');
  });

  it('classifies drop collection as dangerous requiring literal word "DROP COLLECTION"', () => {
    const res = classifyQuery({
      collection: 'temp_data',
      operation: 'drop',
      rawDisplay: JSON.stringify({ collection: 'temp_data', operation: 'drop' }),
    }, 'mongodb');

    expect(res.category).toBe('dangerous');
    expect(res.requiresLiteralWord).toBe(true);
    expect(res.literalWord).toBe('DROP COLLECTION');
  });

  it('classifies createIndex and createCollection as structural', () => {
    const idxRes = classifyQuery({
      collection: 'orders',
      operation: 'createIndex',
      filter: { userId: 1 },
      options: { background: true },
      rawDisplay: JSON.stringify({ collection: 'orders', operation: 'createIndex' }),
    }, 'mongodb');

    expect(idxRes.category).toBe('structural');
    expect(idxRes.isStructural).toBe(true);

    const colRes = classifyQuery({
      collection: 'audit_logs',
      operation: 'createCollection',
      rawDisplay: JSON.stringify({ collection: 'audit_logs', operation: 'createCollection' }),
    }, 'mongodb');

    expect(colRes.category).toBe('structural');
    expect(colRes.isStructural).toBe(true);
  });
});

describe('Guardrails and Strict Wipe Enforcement', () => {
  it('hard-blocks full wipe when strictMode is ON and allowFullWipe is false', () => {
    const wipe = classifyQuery({ sql: 'DROP DATABASE prod;', rawDisplay: 'DROP DATABASE prod;' }, 'postgres');
    const result = checkStrictWipe(wipe, { strictMode: true, allowFullWipe: false });

    expect(result.blocked).toBe(true);
    expect(result.message).toContain('--strict mode');
  });

  it('allows full wipe when allowFullWipe is true', () => {
    const wipe = classifyQuery({ sql: 'DROP DATABASE prod;', rawDisplay: 'DROP DATABASE prod;' }, 'postgres');
    const result = checkStrictWipe(wipe, { strictMode: true, allowFullWipe: true });

    expect(result.blocked).toBe(false);
  });

  it('correctly classifies obvious database tasks vs out-of-scope requests', async () => {
    const dbTask1 = await classifyIntent('SELECT * FROM users LIMIT 10;');
    expect(dbTask1.isDatabaseTask).toBe(true);

    const dbTask2 = await classifyIntent('how many rows are in the orders table?');
    expect(dbTask2.isDatabaseTask).toBe(true);

    const dbTask3 = await classifyIntent('create index concurrently on users(email)');
    expect(dbTask3.isDatabaseTask).toBe(true);

    const outOfScope1 = await classifyIntent('write a python script to scrape a website');
    expect(outOfScope1.isDatabaseTask).toBe(false);

    const outOfScope2 = await classifyIntent('who was Napoleon Bonaparte?');
    expect(outOfScope2.isDatabaseTask).toBe(false);

    const outOfScope3 = await classifyIntent('write me a poem about databases');
    expect(outOfScope3.isDatabaseTask).toBe(false);
  });

  it('correctly detects explicit no-query instructions', () => {
    expect(isExplicitNoQuery("don't run the query, just do something with the previous results")).toBe(true);
    expect(isExplicitNoQuery("do not run any query, just summarize")).toBe(true);
    expect(isExplicitNoQuery("without running a query, what was the highest salary?")).toBe(true);
    expect(isExplicitNoQuery("don't execute any query")).toBe(true);
    expect(isExplicitNoQuery("no queries please, just explain")).toBe(true);
    expect(isExplicitNoQuery("just use the previous results to format a table")).toBe(true);
    expect(isExplicitNoQuery("just do something with the previous results")).toBe(true);
    expect(isExplicitNoQuery("don't run it, just tell me what it means")).toBe(true);
    expect(isExplicitNoQuery("skip the query and show markdown")).toBe(true);
    expect(isExplicitNoQuery("don't query the database")).toBe(true);
    expect(isExplicitNoQuery("without executing queries")).toBe(true);

    // Negative cases: requests that require queries
    expect(isExplicitNoQuery("SELECT * FROM users;")).toBe(false);
    expect(isExplicitNoQuery("show all users")).toBe(false);
    expect(isExplicitNoQuery("how many orders were placed today?")).toBe(false);
    expect(isExplicitNoQuery("delete from users where id = 1")).toBe(false);
    expect(isExplicitNoQuery("find users with status active")).toBe(false);
  });

  it('classifies explicit no-query requests as valid database session tasks in intent guardrail', async () => {
    const res1 = await classifyIntent("don't run the query, just do something with the previous results");
    expect(res1.isDatabaseTask).toBe(true);

    const res2 = await classifyIntent("without running a query, summarize the results above");
    expect(res2.isDatabaseTask).toBe(true);

    const res3 = await classifyIntent("just use the previous results");
    expect(res3.isDatabaseTask).toBe(true);
  });
});
