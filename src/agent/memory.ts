import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { getConfigDirPath, maskUrl } from '../config/index.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  query?: string;
  rowCount?: number;
  resultSample?: any[];
  timestamp: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  dbUrl?: string;
  messages: ChatMessage[];
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  dbUrl?: string;
}

export function getChatsDirPath(): string {
  return path.join(getConfigDirPath(), 'chats');
}

export class ChatMemoryManager {
  private chatsDir: string;

  constructor(customDir?: string) {
    this.chatsDir = customDir || getChatsDirPath();
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.chatsDir)) {
      try {
        fs.mkdirSync(this.chatsDir, { recursive: true, mode: 0o700 });
      } catch {
        // Safe to ignore permissions error on Windows
      }
    }
  }

  private getFilePath(sessionId: string): string {
    // Sanitize sessionId for filesystem safety
    const safeId = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    return path.join(this.chatsDir, `${safeId}.json`);
  }

  /**
   * Create a new chat session.
   */
  public createSession(initialTitle?: string, dbUrl?: string): ChatSession {
    const id = `chat-${Date.now()}`;
    const session: ChatSession = {
      id,
      title: initialTitle || 'New Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dbUrl,
      messages: [],
    };
    this.saveSession(session);
    return session;
  }

  /**
   * Load an existing session by ID.
   */
  public getSession(sessionId: string): ChatSession | undefined {
    const file = this.getFilePath(sessionId);
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf-8');
        return JSON.parse(content) as ChatSession;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /**
   * Save or update a session to disk.
   */
  public saveSession(session: ChatSession): void {
    this.ensureDirectory();
    session.updatedAt = Date.now();
    const file = this.getFilePath(session.id);
    try {
      fs.writeFileSync(file, JSON.stringify(session, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
    } catch {
      // Disk write failure fallback
    }
  }

  /**
   * List all stored sessions sorted by last updated time (newest first).
   */
  public listSessions(): ChatSessionSummary[] {
    this.ensureDirectory();
    try {
      const files = fs.readdirSync(this.chatsDir).filter((f) => f.endsWith('.json'));
      const summaries: ChatSessionSummary[] = [];

      for (const f of files) {
        try {
          const filePath = path.join(this.chatsDir, f);
          const raw = fs.readFileSync(filePath, 'utf-8');
          const session = JSON.parse(raw) as ChatSession;
          if (session && session.id) {
            summaries.push({
              id: session.id,
              title: session.title || 'Untitled Chat',
              messageCount: session.messages ? session.messages.length : 0,
              createdAt: session.createdAt || 0,
              updatedAt: session.updatedAt || 0,
              dbUrl: session.dbUrl ? maskUrl(session.dbUrl) : undefined,
            });
          }
        } catch {
          // Skip corrupt file
        }
      }

      return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  /**
   * Append a message to a session, updating session title if first turn.
   */
  public addMessage(
    sessionId: string,
    message: Omit<ChatMessage, 'timestamp'>,
    dbUrl?: string
  ): ChatSession {
    let session = this.getSession(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        title: message.content.slice(0, 40).trim() || 'New Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        dbUrl,
        messages: [],
      };
    }

    if (dbUrl && !session.dbUrl) {
      session.dbUrl = dbUrl;
    }

    // Auto-update title if it's currently default and this is a user message
    if (message.role === 'user' && (session.title === 'New Chat' || !session.title)) {
      session.title = message.content.slice(0, 45).trim();
    }

    session.messages.push({
      ...message,
      timestamp: Date.now(),
    });

    this.saveSession(session);
    return session;
  }

  /**
   * Convert stored history into LangChain messages for model prompts.
   */
  public toLangChainMessages(sessionId: string, maxTurns = 6): BaseMessage[] {
    const session = this.getSession(sessionId);
    if (!session || !session.messages || session.messages.length === 0) {
      return [];
    }

    // Take the last maxTurns messages
    const recent = session.messages.slice(-maxTurns);
    const result: BaseMessage[] = [];

    for (const m of recent) {
      if (m.role === 'user') {
        result.push(new HumanMessage(m.content));
      } else if (m.role === 'assistant') {
        let text = m.content;
        if (m.query) {
          text = `[Executed Query: ${m.query}]\n${text}`;
        }
        if (m.resultSample && m.resultSample.length > 0) {
          text += `\n[Previous Query Results Sample: ${JSON.stringify(m.resultSample.slice(0, 10))}]`;
        }
        result.push(new AIMessage(text));
      }
    }

    return result;
  }

  /**
   * Get a compact text representation of recent turns for guardrail/target classification.
   */
  public getRecentSummary(sessionId: string, maxTurns = 4): string {
    const session = this.getSession(sessionId);
    if (!session || !session.messages || session.messages.length === 0) {
      return '';
    }

    const recent = session.messages.slice(-maxTurns);
    return recent
      .map((m) => {
        const prefix = m.role === 'user' ? 'User:' : 'Assistant:';
        const q = m.query ? ` (Query: ${m.query})` : '';
        const rc = typeof m.rowCount === 'number' ? ` (${m.rowCount} rows)` : '';
        return `${prefix} ${m.content}${q}${rc}`;
      })
      .join('\n');
  }

  /**
   * Clear all messages from a session.
   */
  public clearSession(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session) {
      session.messages = [];
      this.saveSession(session);
    }
  }

  /**
   * Delete a session file permanently.
   */
  public deleteSession(sessionId: string): boolean {
    const file = this.getFilePath(sessionId);
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }
}
