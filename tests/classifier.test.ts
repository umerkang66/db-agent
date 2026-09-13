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

describe('Database Admin Tasks Classification & --allow-full-wipe Enforcement', () => {
  it('classifies PostgreSQL GRANT and REVOKE as admin tasks', () => {
    const grantRes = classifyQuery({ sql: 'GRANT SELECT ON users TO reader;', rawDisplay: 'GRANT SELECT ON users TO reader;' }, 'postgres');
    expect(grantRes.category).toBe('admin');
    expect(grantRes.isAdmin).toBe(true);
    expect(grantRes.isDestructive).toBe(false);

    const revokeRes = classifyQuery({ sql: 'REVOKE ALL ON users FROM public;', rawDisplay: 'REVOKE ALL ON users FROM public;' }, 'postgres');
    expect(revokeRes.category).toBe('admin');
    expect(revokeRes.isAdmin).toBe(true);
  });

  it('classifies PostgreSQL user/role creation and drops as admin tasks', () => {
    const createRoleRes = classifyQuery({ sql: 'CREATE ROLE analyst WITH LOGIN;', rawDisplay: 'CREATE ROLE analyst WITH LOGIN;' }, 'postgres');
    expect(createRoleRes.category).toBe('admin');
    expect(createRoleRes.isAdmin).toBe(true);
    expect(createRoleRes.isDestructive).toBe(false);

    const dropRoleRes = classifyQuery({ sql: 'DROP ROLE analyst;', rawDisplay: 'DROP ROLE analyst;' }, 'postgres');
    expect(dropRoleRes.category).toBe('admin');
    expect(dropRoleRes.isAdmin).toBe(true);
    expect(dropRoleRes.isDestructive).toBe(true);
    expect(dropRoleRes.requiresLiteralWord).toBe(true);
    expect(dropRoleRes.literalWord).toBe('DROP ROLE');

    const dropUserRes = classifyQuery({ sql: 'DROP USER old_user;', rawDisplay: 'DROP USER old_user;' }, 'postgres');
    expect(dropUserRes.category).toBe('admin');
    expect(dropUserRes.isAdmin).toBe(true);
    expect(dropUserRes.isDestructive).toBe(true);
    expect(dropUserRes.literalWord).toBe('DROP USER');
  });

  it('classifies PostgreSQL maintenance operations (VACUUM, REINDEX, CHECKPOINT) as admin tasks', () => {
    const vacuumRes = classifyQuery({ sql: 'VACUUM ANALYZE users;', rawDisplay: 'VACUUM ANALYZE users;' }, 'postgres');
    expect(vacuumRes.category).toBe('admin');
    expect(vacuumRes.isAdmin).toBe(true);

    const vacuumFullRes = classifyQuery({ sql: 'VACUUM FULL users;', rawDisplay: 'VACUUM FULL users;' }, 'postgres');
    expect(vacuumFullRes.category).toBe('admin');
    expect(vacuumFullRes.isAdmin).toBe(true);
    expect(vacuumFullRes.warnings.some((w) => w.includes('exclusively locks'))).toBe(true);

    const reindexRes = classifyQuery({ sql: 'REINDEX TABLE users;', rawDisplay: 'REINDEX TABLE users;' }, 'postgres');
    expect(reindexRes.category).toBe('admin');
    expect(reindexRes.isAdmin).toBe(true);

    const checkpointRes = classifyQuery({ sql: 'CHECKPOINT;', rawDisplay: 'CHECKPOINT;' }, 'postgres');
    expect(checkpointRes.category).toBe('admin');
    expect(checkpointRes.isAdmin).toBe(true);
  });

  it('classifies pg_terminate_backend and ALTER SYSTEM as admin tasks', () => {
    const killRes = classifyQuery({ sql: 'SELECT pg_terminate_backend(1234);', rawDisplay: 'SELECT pg_terminate_backend(1234);' }, 'postgres');
    expect(killRes.category).toBe('admin');
    expect(killRes.isAdmin).toBe(true);
    expect(killRes.isDestructive).toBe(true);

    const alterSysRes = classifyQuery({ sql: "ALTER SYSTEM SET work_mem = '64MB';", rawDisplay: "ALTER SYSTEM SET work_mem = '64MB';" }, 'postgres');
    expect(alterSysRes.category).toBe('admin');
    expect(alterSysRes.isAdmin).toBe(true);
  });

  it('classifies MongoDB admin tasks (dropDatabase, createUser, dropUser, compact)', () => {
    const dropDb = classifyQuery({ operation: 'dropDatabase', rawDisplay: '{"operation": "dropDatabase"}' }, 'mongodb');
    expect(dropDb.category).toBe('full_wipe');
    expect(dropDb.isAdmin).toBe(true);
    expect(dropDb.isFullWipe).toBe(true);

    const createUser = classifyQuery({ operation: 'createUser', rawDisplay: '{"operation": "createUser"}' }, 'mongodb');
    expect(createUser.category).toBe('admin');
    expect(createUser.isAdmin).toBe(true);

    const dropUser = classifyQuery({ operation: 'dropUser', rawDisplay: '{"operation": "dropUser"}' }, 'mongodb');
    expect(dropUser.category).toBe('admin');
    expect(dropUser.isAdmin).toBe(true);
    expect(dropUser.isDestructive).toBe(true);
    expect(dropUser.literalWord).toBe('DROP USER');
  });

  it('hard-blocks admin tasks when strictMode is ON and allowFullWipe is false', () => {
    const adminQuery = classifyQuery({ sql: 'GRANT ALL ON users TO app_admin;', rawDisplay: 'GRANT ALL ON users TO app_admin;' }, 'postgres');
    const result = checkStrictWipe(adminQuery, { strictMode: true, allowFullWipe: false });

    expect(result.blocked).toBe(true);
    expect(result.message).toContain('database admin tasks are prohibited');
    expect(result.message).toContain('--allow-full-wipe');
  });

  it('allows db admin tasks when --allow-full-wipe is true', () => {
    const adminQuery = classifyQuery({ sql: 'GRANT ALL ON users TO app_admin;', rawDisplay: 'GRANT ALL ON users TO app_admin;' }, 'postgres');
    const result = checkStrictWipe(adminQuery, { strictMode: true, allowFullWipe: true });

    expect(result.blocked).toBe(false);
  });

  it('classifies natural language database admin requests as database tasks in intent guardrail', async () => {
    const task1 = await classifyIntent('grant select on users to reporter');
    expect(task1.isDatabaseTask).toBe(true);

    const task2 = await classifyIntent('vacuum analyze the users table');
    expect(task2.isDatabaseTask).toBe(true);

    const task3 = await classifyIntent('reindex the database');
    expect(task3.isDatabaseTask).toBe(true);

    const task4 = await classifyIntent('terminate active connection process 5432');
    expect(task4.isDatabaseTask).toBe(true);
  });

  it('classifies multi-table CREATE TABLE and INSERT INTO as structural with seed data explanation', () => {
    const multiSql = `
      CREATE TABLE IF NOT EXISTS customers (id SERIAL PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS spendings (id SERIAL PRIMARY KEY, customer_id INT, amount NUMERIC);
      INSERT INTO customers (name) VALUES ('Alice');
      INSERT INTO spendings (customer_id, amount) VALUES (1, 100);
    `;
    const res = classifyQuery({ sql: multiSql, rawDisplay: multiSql }, 'postgres');

    expect(res.category).toBe('structural');
    expect(res.isStructural).toBe(true);
    expect(res.isDestructive).toBe(false);
    expect(res.requiresLiteralWord).toBe(false);
    expect(res.explanation).toContain('customers, spendings');
    expect(res.explanation).toContain('populates seed data');
  });

  it('detects dangerous DROP TABLE even when hidden in stacked statements', () => {
    const stackedSql = `
      CREATE TABLE foo (id INT);
      DROP TABLE audit_logs;
    `;
    const res = classifyQuery({ sql: stackedSql, rawDisplay: stackedSql }, 'postgres');

    expect(res.category).toBe('dangerous');
    expect(res.isDestructive).toBe(true);
    expect(res.requiresLiteralWord).toBe(true);
    expect(res.literalWord).toBe('DROP TABLE');
  });

  it('classifies MongoDB multi-collection operations correctly', () => {
    const multiOp = {
      rawDisplay: 'multi-op',
      operations: [
        { collection: 'users', operation: 'insertMany', documents: [{ name: 'Alice' }] },
        { collection: 'orders', operation: 'insertMany', documents: [{ orderId: 101 }] },
      ],
    };
    const res = classifyQuery(multiOp, 'mongodb');

    expect(res.category).toBe('write');
    expect(res.isDestructive).toBe(false);
    expect(res.explanation).toContain('users, orders');
  });

  it('classifies fake data seeding requests as database tasks in intent guardrail', async () => {
    const prompt = 'add fake users, and their spendings in a different tables, and what they bought how much they bought in a different tables.';
    const res = await classifyIntent(prompt);
    expect(res.isDatabaseTask).toBe(true);
  });
});
