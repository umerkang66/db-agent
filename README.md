# 🤖 db-agent

> **Production-grade agentic database assistant CLI powered by LangGraph and Multi-Provider AI (Google Gemini, OpenAI, and Anthropic Claude).**

`db-agent` connects directly to your live database (PostgreSQL or MongoDB), introspects schemas, reasons through multi-turn queries, calculates statistical summaries, and safeguards your data with an uncompromising multi-tiered safety system.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=18](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org)

---

## 🌟 Key Capabilities

- 🔌 **Unified Database Support**: Seamlessly works with **PostgreSQL** and **MongoDB** via automatic URL scheme detection (`postgres://`, `postgresql://`, `mongodb://`, `mongodb+srv://`).
- 🧠 **Multi-Provider LLM Engine**: Native support for **Google Gemini** (`gemini-2.5-flash`), **OpenAI** (`gpt-4o`), and **Anthropic** (`claude-3-5-sonnet-latest`). Switch providers with a single flag.
- 🔄 **Explicit LangGraph State Pipeline**: 8-stage deterministic state graph:
  1. `inspect_schema` (cached per-session, auto-invalidated after DDL)
  2. `identify_targets` (schema-aware entity selection)
  3. `generate_query` (parameterized SQL or typed Mongo queries)
  4. `classify_safety` (danger & structural categorization)
  5. `request_confirmation` (dry-run affected row counts & literal word verification)
  6. `execute_query` (only after explicit user approval)
  7. `analyze_results` (computed stats: sums, averages, min, max, stdDev)
  8. `produce_conclusion` (grounded strictly in execution results)
- 🛡️ **Strict Intent Guardrails**: Short-circuits non-database requests (general coding, web scraping, creative writing, chat) with a zero-latency refusal before reaching the agent graph.
- ⚠️ **Zero-Accident Safety UX**:
  - Pre-run **dry-run row counts** (`Affected rows: N`) for `DELETE`, `UPDATE`, `DROP`, and `TRUNCATE`.
  - Operations lacking a `WHERE` or filter clause require typing a **literal confirmation phrase** (e.g. `DELETE ALL`).
  - `--strict` mode (default ON) prevents full database wipes unless `--allow-full-wipe` is explicitly supplied.
- 🛠️ **Modern Structural / Additive DDL Support**:
  - `CREATE TABLE`, `CREATE SCHEMA`, `CREATE INDEX`, `ALTER TABLE ADD COLUMN`, `createCollection`, `createIndex`.
  - Plain-English impact summaries before applying changes.
  - Warns if PostgreSQL index is not `CONCURRENTLY` (or Mongo index is not `background: true`).
  - Automatic schema cache invalidation upon successful DDL execution.
- 🔒 **Secure Credential Management**: Stores configuration in `~/.db-agent/config.json` with `chmod 600` POSIX permissions. Sensitive credentials and passwords are masked everywhere in logs and terminal outputs.

---

## 📦 Installation

Install globally via npm:

```bash
npm install -g db-agent
```

Or run directly using `npx`:

```bash
npx db-agent
```

---

## 🚀 Quick Start

### 1. Configure Credentials

You can supply credentials via environment variables, CLI flags, or interactive prompt.

#### Environment Variables (Highest Precedence)

```bash
# Database URL
export DATABASE_URL="postgresql://postgres:password@localhost:5432/my_database"
# Or MongoDB:
# export DATABASE_URL="mongodb+srv://admin:password@cluster.mongodb.net/my_database"

# Provide ANY of the following API keys:
export GEMINI_API_KEY="AIzaSy..."
export OPENAI_API_KEY="sk-proj-..."
export ANTHROPIC_API_KEY="sk-ant-..."
```

#### Stored Config (`~/.db-agent/config.json`)

You can persist your configuration once:

```bash
# Save default database URL
db-agent config --set-db "postgresql://user:pass@localhost:5432/mydb"

# Save API keys
db-agent config --set-gemini "AIzaSy..."
db-agent config --set-openai "sk-..."
db-agent config --set-anthropic "sk-ant-..."

# Set default provider and model
db-agent config --set-provider google
db-agent config --set-model gemini-2.5-flash

# Inspect saved configuration (secrets are masked)
db-agent config --show
```

### 2. Launch the Agent

```bash
# Connect using saved configuration:
db-agent

# Connect to a specific database (saves to config if first run):
db-agent "postgresql://user:password@localhost:5432/sales_db"

# Use OpenAI:
db-agent -p openai -m gpt-4o

# Use Anthropic:
db-agent -p anthropic -m claude-3-5-sonnet-latest
```

---

## 🖥️ Interactive REPL & Dot Commands

When inside `db-agent`, you can chat naturally or use dot commands:

```text
db-agent [postgres]> .tables
db-agent [postgres]> .schema users
db-agent [postgres]> .refresh
db-agent [postgres]> .help
db-agent [postgres]> exit
```

| Command                    | Description                                                            |
| -------------------------- | ---------------------------------------------------------------------- |
| `.tables` / `.collections` | List all discovered tables or collections with row/document counts     |
| `.schema [name]`           | Display columns, data types, nullability, and primary keys for a table |
| `.refresh`                 | Invalidate and re-introspect the database schema cache                 |
| `.clear`                   | Clear the terminal screen                                              |
| `.help`                    | Show command reference and usage examples                              |
| `exit` / `quit`            | Gracefully disconnect and exit                                         |

---

## 🛡️ Safety & Guardrails System

### 1. Intent Pre-Processing Classifier

`db-agent` is strictly a database operations assistant. Before user input reaches the LLM query pipeline, it passes through an intent classifier:

- ✅ **In Scope (`database_task`)**: Schema inspection, querying, data aggregation, statistics, CRUD mutations, and structural DDL.
- ❌ **Out of Scope (`out_of_scope`)**: Code writing scripts (e.g. "write a python web scraper"), general Q&A, chat, creative writing.

When an out-of-scope request is detected, the agent immediately halts without generating any database queries:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ 🛡️ GUARDRAIL ENFORCEMENT                                               │
│                                                                        │
│ I'm scoped to database operations on your connected DB only           │
│ (schema inspection, queries, CRUD, analysis). I can't help with that.  │
│                                                                        │
│ Reason: Matched out-of-scope pattern                                   │
└────────────────────────────────────────────────────────────────────────┘
```

### 2. Mutation & Dangerous Query UX

Every mutating query triggers a safety classification before anything touches the database:

#### Safe Read (SELECT / find)

```text
┌────────────────────────────────────────────────────────┐
│ 🔍 READ QUERY                                          │
│                                                        │
│ SELECT id, email, created_at FROM users LIMIT 10;      │
└────────────────────────────────────────────────────────┘
? Execute read query? (Y/n)
```

#### Structural DDL (Additive)

```text
┌────────────────────────────────────────────────────────────────────────┐
│ 🛠️  STRUCTURAL DDL OPERATION                                           │
│                                                                        │
│ CREATE INDEX idx_orders_customer ON orders (customer_id);              │
│                                                                        │
│ Effect: Creates an index on orders (may lock table during build).      │
│                                                                        │
│ 💡 Recommendation:                                                     │
│ CREATE INDEX CONCURRENTLY idx_orders_customer ON orders (customer_id); │
│                                                                        │
│ • Index is not being created CONCURRENTLY. This will lock write        │
│   operations on the table during index creation.                       │
└────────────────────────────────────────────────────────────────────────┘
? Apply this structural change? (Y/n)
```

#### Filtered Dangerous Query (DELETE / UPDATE with WHERE)

```text
┌────────────────────────────────────────────────────────┐
│ ⚠️  DANGEROUS OPERATION                                │
│                                                        │
│ DELETE FROM users                                      │
│ WHERE last_login < '2024-09-13';                       │
│                                                        │
│ Affected rows: 14,821                                  │
│                                                        │
│ • Mutates existing database records.                   │
└────────────────────────────────────────────────────────┘
? Proceed with dangerous operation? (y/N)
```

#### Unbounded Mutation (Missing WHERE Clause)

Any mutation that omits a WHERE or filter clause requires literal keyword confirmation:

```text
┌────────────────────────────────────────────────────────┐
│ ⚠️  DANGEROUS OPERATION                                │
│                                                        │
│ DELETE FROM users;                                     │
│                                                        │
│ Affected rows: 154,200                                 │
│                                                        │
│ • No WHERE clause specified: EVERY row in the table    │
│   will be deleted!                                     │
└────────────────────────────────────────────────────────┘
? Destructive operation with no filter. Type "DELETE ALL" to confirm:
```

#### Strict Mode Full Wipe Protection

By default, `--strict` mode is enabled. An attempt to drop the entire database or all tables is blocked outright:

```text
Operation blocked by --strict mode: full database or all-table drop is prohibited.
To allow this, start db-agent with --allow-full-wipe.
```

---

## 📊 Multi-Provider Configuration Precedence

Credentials and options are resolved following strict precedence:

```
CLI Arguments (--key, --provider, [dbUrl])
    └── Environment Variables (DATABASE_URL, GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY)
          └── Stored Config (~/.db-agent/config.json)
                └── Interactive Terminal Prompt
```

---

## 🧪 Testing & Verification

The test suite covers database URL detection, security classification, DDL warnings, intent filtering, and credential masking:

```bash
# Run unit test suite
npm test

# Build TypeScript
npm run build
```

---

## 📜 License

[MIT](LICENSE)
