import { describe, it, expect } from 'vitest';
import {
  promptConfirm,
  promptInput,
  requestUserConfirmation,
} from '../src/safety/confirm.js';
import { SafetyClassification } from '../src/safety/classifier.js';
import { ExecutableQuery } from '../src/db/adapter.js';

describe('Safety Confirmation & Input Handling', () => {
  it('promptConfirm defaults to defaultValue on empty input', async () => {
    const defaultTrue = await promptConfirm('Execute?', true, async () => '');
    expect(defaultTrue).toBe(true);

    const defaultFalse = await promptConfirm('Execute?', false, async () => '   ');
    expect(defaultFalse).toBe(false);
  });

  it('promptConfirm recognizes positive answers', async () => {
    for (const val of ['y', 'Y', 'yes', 'YES', 'true', '1']) {
      const res = await promptConfirm('Execute?', false, async () => val);
      expect(res).toBe(true);
    }
  });

  it('promptConfirm recognizes negative answers', async () => {
    for (const val of ['n', 'N', 'no', 'NO', 'false', '0']) {
      const res = await promptConfirm('Execute?', true, async () => val);
      expect(res).toBe(false);
    }
  });

  it('promptInput trims whitespace from response', async () => {
    const res = await promptInput('Enter word:', async () => '  DROP DATABASE   \n');
    expect(res).toBe('DROP DATABASE');
  });

  it('requestUserConfirmation confirms read query with default Enter', async () => {
    const query: ExecutableQuery = { sql: 'SELECT * FROM users;', rawDisplay: 'SELECT * FROM users;' };
    const safety: SafetyClassification = {
      category: 'read',
      isDestructive: false,
      isStructural: false,
      requiresLiteralWord: false,
      warnings: [],
    };

    const res = await requestUserConfirmation(query, safety, null, async () => '');
    expect(res.confirmed).toBe(true);
  });

  it('requestUserConfirmation rejects read query when user enters n', async () => {
    const query: ExecutableQuery = { sql: 'SELECT * FROM users;', rawDisplay: 'SELECT * FROM users;' };
    const safety: SafetyClassification = {
      category: 'read',
      isDestructive: false,
      isStructural: false,
      requiresLiteralWord: false,
      warnings: [],
    };

    const res = await requestUserConfirmation(query, safety, null, async () => 'n');
    expect(res.confirmed).toBe(false);
  });

  it('requestUserConfirmation defaults write query to false on Enter', async () => {
    const query: ExecutableQuery = { sql: 'UPDATE users SET active = true WHERE id = 1;', rawDisplay: 'UPDATE users SET active = true WHERE id = 1;' };
    const safety: SafetyClassification = {
      category: 'write',
      isDestructive: false,
      isStructural: false,
      requiresLiteralWord: false,
      warnings: [],
    };

    const res = await requestUserConfirmation(query, safety, 1, async () => '');
    expect(res.confirmed).toBe(false);

    const confirmedRes = await requestUserConfirmation(query, safety, 1, async () => 'y');
    expect(confirmedRes.confirmed).toBe(true);
  });

  it('requestUserConfirmation confirms structural query by default', async () => {
    const query: ExecutableQuery = { sql: 'CREATE INDEX idx_user_email ON users(email);', rawDisplay: 'CREATE INDEX idx_user_email ON users(email);' };
    const safety: SafetyClassification = {
      category: 'write',
      isDestructive: false,
      isStructural: true,
      requiresLiteralWord: false,
      explanation: 'Creates an index.',
      warnings: [],
    };

    const res = await requestUserConfirmation(query, safety, null, async () => '');
    expect(res.confirmed).toBe(true);
  });

  it('requestUserConfirmation requires exact literal word for dangerous query without WHERE', async () => {
    const query: ExecutableQuery = { sql: 'DELETE FROM users;', rawDisplay: 'DELETE FROM users;' };
    const safety: SafetyClassification = {
      category: 'dangerous',
      isDestructive: true,
      isStructural: false,
      requiresLiteralWord: true,
      literalWord: 'DELETE ALL',
      warnings: ['Destructive query without WHERE clause.'],
    };

    // Mismatch
    const mismatch = await requestUserConfirmation(query, safety, 100, async () => 'delete');
    expect(mismatch.confirmed).toBe(false);
    expect(mismatch.reason).toContain('Confirmation word mismatch');

    // Exact match
    const match = await requestUserConfirmation(query, safety, 100, async () => 'DELETE ALL');
    expect(match.confirmed).toBe(true);
  });

  it('requestUserConfirmation requires literal word for full wipe', async () => {
    const query: ExecutableQuery = { sql: 'DROP DATABASE test_db;', rawDisplay: 'DROP DATABASE test_db;' };
    const safety: SafetyClassification = {
      category: 'dangerous',
      isDestructive: true,
      isStructural: true,
      isFullWipe: true,
      requiresLiteralWord: true,
      literalWord: 'DROP DATABASE',
      warnings: ['Full database wipe attempted.'],
    };

    const mismatch = await requestUserConfirmation(query, safety, null, async () => 'DROP');
    expect(mismatch.confirmed).toBe(false);

    const match = await requestUserConfirmation(query, safety, null, async () => 'DROP DATABASE');
    expect(match.confirmed).toBe(true);
  });

  it('ensures process.stdin is not left paused after confirmation', async () => {
    process.stdin.resume();
    const query: ExecutableQuery = { sql: 'SELECT 1;', rawDisplay: 'SELECT 1;' };
    const safety: SafetyClassification = {
      category: 'read',
      isDestructive: false,
      isStructural: false,
      requiresLiteralWord: false,
      warnings: [],
    };

    await requestUserConfirmation(query, safety, null, async () => 'y');
    expect(process.stdin.isPaused()).toBe(false);
  });
});
