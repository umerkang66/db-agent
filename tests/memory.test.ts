import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatMemoryManager } from '../src/agent/memory.js';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

describe('ChatMemoryManager (Per-Chat Memory)', () => {
  let tempDir: string;
  let manager: ChatMemoryManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandal-memory-test-'));
    manager = new ChatMemoryManager(tempDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('creates and retrieves a new chat session', () => {
    const session = manager.createSession('Initial Title', 'postgres://localhost/testdb');
    expect(session.id).toBeDefined();
    expect(session.title).toBe('Initial Title');
    expect(session.messages).toEqual([]);
    expect(session.dbUrl).toBe('postgres://localhost/testdb');

    const loaded = manager.getSession(session.id);
    expect(loaded).toBeDefined();
    expect(loaded?.id).toBe(session.id);
    expect(loaded?.title).toBe('Initial Title');
  });

  it('appends messages and updates session title on first turn', () => {
    const session = manager.createSession('New Chat');
    manager.addMessage(session.id, {
      role: 'user',
      content: 'Show top 10 users signed up recently',
    });

    const afterUser = manager.getSession(session.id);
    expect(afterUser?.messages.length).toBe(1);
    expect(afterUser?.messages[0].role).toBe('user');
    expect(afterUser?.title).toContain('Show top 10 users');

    manager.addMessage(session.id, {
      role: 'assistant',
      content: 'Here are the top 10 users:',
      query: 'SELECT * FROM users LIMIT 10;',
      rowCount: 10,
    });

    const afterAi = manager.getSession(session.id);
    expect(afterAi?.messages.length).toBe(2);
    expect(afterAi?.messages[1].role).toBe('assistant');
    expect(afterAi?.messages[1].query).toBe('SELECT * FROM users LIMIT 10;');
  });

  it('converts conversation history to LangChain BaseMessage array', () => {
    const session = manager.createSession('Query Turn');
    manager.addMessage(session.id, {
      role: 'user',
      content: 'Show customers',
    });
    manager.addMessage(session.id, {
      role: 'assistant',
      content: 'Found 5 customers.',
      query: 'SELECT * FROM customers;',
    });

    const messages = manager.toLangChainMessages(session.id);
    expect(messages.length).toBe(2);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[0].content).toBe('Show customers');
    expect(messages[1]).toBeInstanceOf(AIMessage);
    expect(messages[1].content).toContain('[Executed Query: SELECT * FROM customers;]');
    expect(messages[1].content).toContain('Found 5 customers.');
  });

  it('provides compact summary for guardrails and intent classification', () => {
    const session = manager.createSession('Summary Test');
    manager.addMessage(session.id, {
      role: 'user',
      content: 'List active subscriptions',
    });
    manager.addMessage(session.id, {
      role: 'assistant',
      content: 'Found 12 subscriptions',
      query: 'SELECT * FROM subscriptions WHERE status = "active"',
    });

    const summary = manager.getRecentSummary(session.id);
    expect(summary).toContain('User: List active subscriptions');
    expect(summary).toContain('Assistant: Found 12 subscriptions');
    expect(summary).toContain('Query: SELECT * FROM subscriptions');
  });

  it('lists stored sessions sorted by updatedAt descending', async () => {
    const s1 = manager.createSession('Session One');
    // small sleep to guarantee different timestamps
    await new Promise((r) => setTimeout(r, 10));
    const s2 = manager.createSession('Session Two');

    const list = manager.listSessions();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(s2.id);
    expect(list[1].id).toBe(s1.id);
  });

  it('clears session messages while preserving session ID', () => {
    const session = manager.createSession('Clear Test');
    manager.addMessage(session.id, { role: 'user', content: 'hello' });
    expect(manager.getSession(session.id)?.messages.length).toBe(1);

    manager.clearSession(session.id);
    const cleared = manager.getSession(session.id);
    expect(cleared?.messages).toEqual([]);
  });

  it('deletes a session file permanently', () => {
    const session = manager.createSession('Delete Test');
    expect(manager.getSession(session.id)).toBeDefined();

    const result = manager.deleteSession(session.id);
    expect(result).toBe(true);
    expect(manager.getSession(session.id)).toBeUndefined();
  });
});
