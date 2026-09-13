import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import { INTENT_CLASSIFICATION_PROMPT, REFUSAL_MESSAGE } from './prompts.js';
import { SafetyClassification } from '../safety/classifier.js';

export interface IntentResult {
  isDatabaseTask: boolean;
  reason?: string;
}

const OBVIOUS_OUT_OF_SCOPE_PATTERNS = [
  /write\s+(?:me\s+)?(?:a\s+)?python\s+script/i,
  /scrape\s+(?:a\s+)?website/i,
  /write\s+(?:me\s+)?(?:a\s+)?(?:bash|shell|sh|powershell)\s+script/i,
  /create\s+(?:a\s+)?(?:react|vue|angular|flask|django|express)\s+app/i,
  /write\s+(?:me\s+)?(?:a\s+)?(?:poem|essay|story|song|joke)/i,
  /who\s+(?:was|is)\s+/i,
  /what\s+is\s+the\s+capital\s+of/i,
  /how\s+to\s+cook/i,
  /solve\s+(?:this\s+)?(?:math|equation|integral)/i,
  /help\s+me\s+with\s+(?:my\s+)?homework/i,
  /acting\s+as\s+a\s+general\s+chatbot/i,
];

const OBVIOUS_DATABASE_PATTERNS = [
  /^(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|EXPLAIN|SHOW|DESCRIBE|WITH|GRANT|REVOKE|VACUUM|REINDEX|CHECKPOINT|DISCARD|RESET|LOCK)\b/i,
  /\b(?:table|tables|collection|collections|schema|column|columns|index|indexes|foreign key|primary key)\b/i,
  /\b(?:find|aggregate|count|where|group by|order by|having|limit|join|left join|inner join)\b/i,
  /\b(?:how many (?:users|rows|records|orders|items|products|documents))\b/i,
  /\b(?:database|postgres|mongodb|mongo|pg_)\b/i,
  /\b(?:query|queries|sql|result|results|rows?|records?)\b/i,
  /\b(?:role|roles|permission|permissions|privilege|privileges|admin|administration|vacuum|reindex|checkpoint|terminate|kill\s+query|backend)\b/i,
  /\b(?:fake|mock|seed|populate|sample|test)\s+(?:users?|orders?|products?|customers?|data|rows?|records?|documents?|tables?|collections?|spendings?|purchases?)\b/i,
  /\b(?:add|insert|create|populate|seed|generate)\b.*?\b(?:users?|orders?|products?|customers?|data|rows?|records?|documents?|tables?|collections?|spendings?|purchases?)\b/i,
];

/**
 * Detects if the user explicitly commanded NOT to run/execute any query,
 * or to just use/format/inspect existing/previous results.
 */
export function isExplicitNoQuery(input: string): boolean {
  const trimmed = input.trim();
  const patterns = [
    // don't / do not / shouldn't / stop / avoid running / executing / calling / issuing query / queries / sql / command
    /\b(?:don'?t|do\s+not|never|shouldn'?t|stop|avoid)\s+(?:run|running|execute|executing|call|calling|issue|issuing|send|sending|make|making)\s+(?:any\s+|the\s+|a\s+|new\s+)?(?:query|queries|sql|command|db\s+query|database\s+query)\b/i,

    // without / no running / executing / making queries
    /\b(?:without|no)\s+(?:running|executing|making|issuing|calling)\s+(?:any\s+|the\s+|a\s+|new\s+)?(?:query|queries|sql|command)\b/i,

    // no query / no queries / skip the query / skip execution
    /\b(?:no\s+query|no\s+queries|skip\s+(?:the\s+)?query|skip\s+execution)\b/i,

    // don't query / do not query (the database)
    /\b(?:don'?t|do\s+not|never)\s+query(?:\s+(?:the\s+database|the\s+db|again))?\b/i,

    // don't / do not run / execute it
    /\b(?:don'?t|do\s+not|never)\s+(?:run|execute)\s+it\b/i,

    // don't execute anything / don't run anything
    /\b(?:don'?t|do\s+not|never)\s+(?:run|execute)\s+anything\b/i,

    // just use / take / look at / do something with the previous / last / prior results / output / rows
    /\bjust\s+(?:use|take|from|look\s+at|work\s+with|do\s+something\s+with)\s+(?:the\s+)?(?:previous|last|prior|above|earlier)\s+(?:results?|data|output|rows?)\b/i,

    // from / using / with the previous results ... don't run / do not run / without querying
    /\b(?:from|using|with)\s+(?:the\s+)?(?:previous|last|prior|above|earlier)\s+(?:results?|data|output|rows?)[^,\n.]*?(?:don'?t|do\s+not|without)\s+(?:run|running|query|querying)\b/i,

    // don't run ... previous results
    /\b(?:don'?t|do\s+not|without)\s+(?:run|running|execute|executing)[^,\n.]*?(?:previous|last|prior|above|earlier)\s+(?:results?|data|output|rows?)\b/i,
  ];

  return patterns.some((pattern) => pattern.test(trimmed));
}

/**
 * Classifies user intent BEFORE it reaches the LangGraph agent pipeline.
 * Rule-based first for high throughput and zero latency, with LLM fallback.
 */
export async function classifyIntent(
  input: string,
  model?: BaseChatModel,
  historyContext?: string
): Promise<IntentResult> {
  const trimmed = input.trim();

  // 1. Fast regex checks for obvious out-of-scope queries
  for (const pattern of OBVIOUS_OUT_OF_SCOPE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isDatabaseTask: false,
        reason: 'Matched out-of-scope pattern',
      };
    }
  }

  // Explicit no-query instructions concerning previous results/session are database tasks
  if (isExplicitNoQuery(trimmed)) {
    return { isDatabaseTask: true };
  }

  // 2. Fast regex checks for obvious database queries
  for (const pattern of OBVIOUS_DATABASE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isDatabaseTask: true,
      };
    }
  }

  // Short queries like "tables", "schema", "help", "users"
  if (/^(?:tables|collections|schema|indexes|views|stats|count|info)$/i.test(trimmed)) {
    return { isDatabaseTask: true };
  }

  // If there is prior conversation context, common conversational follow-ups are database tasks
  if (
    historyContext &&
    /^(?:now\s+|and\s+|also\s+|then\s+)?(?:count|sort|filter|show|order|group|limit|delete|update|find|export|why|how many|what about|which ones?|where|don'?t|do not|format|summarize|explain)\b/i.test(
      trimmed
    )
  ) {
    return { isDatabaseTask: true };
  }

  // 3. Fallback to lightweight LLM classifier
  if (!model) {
    // If no model provided (e.g. offline/testing), assume DB task unless clearly out of scope
    return { isDatabaseTask: true };
  }

  try {
    const promptText = historyContext
      ? `${INTENT_CLASSIFICATION_PROMPT}\n\nRecent conversation context:\n${historyContext}\n\nCurrent user request:\n${trimmed}`
      : `${INTENT_CLASSIFICATION_PROMPT}\n${trimmed}`;

    const response = await model.invoke([
      new HumanMessage(promptText),
    ]);

    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.classification === 'out_of_scope') {
        return {
          isDatabaseTask: false,
          reason: parsed.reason || 'Classified as out of scope by intent guardrail',
        };
      }
      return { isDatabaseTask: true };
    }

    return { isDatabaseTask: true };
  } catch (err) {
    // Defense: on error, default to allowing if it looks remotely database related
    return { isDatabaseTask: true };
  }
}

/**
 * Checks whether an operation is blocked by --strict mode.
 * Default strictMode: true.
 * If strictMode is ON and allowFullWipe is false, any full_wipe or admin operation is hard blocked.
 * With --allow-full-wipe, full wipes and db admin tasks are permitted.
 */
export function checkStrictWipe(
  classification: SafetyClassification,
  options: { strictMode?: boolean; allowFullWipe?: boolean } = {}
): { blocked: boolean; message?: string } {
  const strictMode = options.strictMode !== false; // default true
  const allowFullWipe = options.allowFullWipe === true;

  if (strictMode && !allowFullWipe) {
    if (classification.isFullWipe) {
      return {
        blocked: true,
        message:
          'Operation blocked by --strict mode: full database or all-table drop is prohibited. To allow this, start sandal-db with --allow-full-wipe.',
      };
    }
    if (classification.category === 'admin' || classification.isAdmin) {
      return {
        blocked: true,
        message:
          'Operation blocked by --strict mode: database admin tasks are prohibited. To allow this, start sandal-db with --allow-full-wipe.',
      };
    }
  }

  return { blocked: false };
}

export { REFUSAL_MESSAGE };
