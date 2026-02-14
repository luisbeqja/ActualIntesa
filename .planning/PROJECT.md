# ActualIntesa

## What This Is

A Node.js CLI tool that syncs bank transactions from Intesa San Paolo (Italy) into Actual Budget. Uses the Enable Banking Open Banking API with JWT RS256 authentication and @actual-app/api to push transactions. Built for personal use — one command to keep your budget up to date.

## Core Value

Transactions from Intesa San Paolo appear in Actual Budget accurately and without duplicates. If nothing else works, the sync must be reliable.

## Requirements

### Validated

- First-run setup guides user through Enable Banking authentication (app ID, private key) — v1.0
- Setup starts bank authorization for Intesa San Paolo and user completes via browser — v1.0
- User configures Actual Budget connection (server URL, password, budget ID, account ID) in .env — v1.0
- On each run, fetch new transactions from Enable Banking since last sync date — v1.0
- Map Enable Banking fields to Actual format (dates, amounts in cents, payees, notes) — v1.0
- Import mapped transactions into configured Actual Budget account via @actual-app/api — v1.0
- Duplicate detection using Enable Banking transactionId as imported_id — v1.0
- Save last sync date to .env so next run only fetches new transactions — v1.0
- --dry-run flag to preview transactions without importing — v1.0
- Print sync summary (fetched, imported, skipped, errors) — v1.0
- Single account configuration (one Intesa account, one Actual account) — v1.0

### Active

- [ ] --setup flag to re-run the bank connection flow
- [ ] Detect expired Enable Banking session and print clear warning telling user to run --setup

### Out of Scope

- Multi-account sync — single account keeps it simple
- Scheduled/cron execution — manual CLI runs only
- Email notifications on link expiry — clear terminal warning instead
- GUI or web interface — CLI only

## AI Budget Agent

A natural language agent that lets users ask questions about their finances via Telegram. Instead of rigid commands, users just type a question and the agent fetches real data from Actual Budget to answer.

### Architecture

Uses Claude's tool-use API. The agent receives a user question, Claude decides which tools to call, executes them against Actual Budget, and returns a natural language summary.

```
User: "How much did I spend on food this month?"
  → Claude receives tools: get_accounts, get_transactions, get_budget_month, etc.
  → Claude calls: get_transactions({ start_date: "2026-02-01", end_date: "2026-02-14" })
  → Gets back transaction data with amounts
  → Claude responds: "You spent €342.50 on food this month"
```

### Files

| File | Purpose |
|------|---------|
| `src/agent/index.js` | Main `askAgent(userConfig, question)` function. Manages the tool-use loop and chat history (last 10 messages per user, in-memory). One `withActual()` session wraps all tool calls per question. |
| `src/agent/tools.js` | Tool definitions (JSON Schema for Claude) and executor functions that call the Actual API. |
| `src/agent/prompt.js` | System prompt with today's date, currency conventions, and formatting instructions (Telegram HTML). |

### Tools

| Tool | Description | Actual API Used |
|------|-------------|-----------------|
| `get_accounts` | List open accounts with balances | `getAccounts()` + `getAccountBalance()` |
| `get_transactions` | Query transactions with filters (date range, account, limit) | `getTransactions()` + `getPayees()` + `getCategories()` |
| `get_budget_month` | Category spending/income breakdown for a month | `getBudgetMonth()` |
| `get_budget_summary` | Compare income/spending across multiple months | `getBudgetMonth()` loop |
| `get_categories` | List all budget categories and groups | `getCategoryGroups()` + `getCategories()` |
| `get_payees` | List all payees/merchants | `getPayees()` |

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Tool-use over RAG | Structured queries are more reliable than embedding financial data. Claude picks the right tool and params. |
| One `withActual()` per question | Avoids init/shutdown overhead between tool calls. Agent opens one Actual session, runs all tools, then closes. |
| `get_transactions` for spending | `getBudgetMonth` only shows categorized spending. Many transactions may be uncategorized, so the prompt instructs Claude to sum raw transactions for spending questions. |
| In-memory chat history | Simple, no persistence needed. 10 messages per user allows follow-up questions. Clears on bot restart or `/clear`. |
| Telegram HTML in prompt | Claude outputs `<b>`, `<i>` tags directly. Avoids Markdown-to-HTML conversion issues. |
| Claude Sonnet model | Balances cost and quality for tool-use tasks. |

### Dependencies

- `@anthropic-ai/sdk` — Claude API client
- `ANTHROPIC_API_KEY` env var required

## Context

- Enable Banking API provides Open Banking/PSD2 access (free linked-account mode for personal use)
- GoCardless Bank Account Data disabled new signups (July 2025) — switched to Enable Banking
- Intesa San Paolo accessible via Enable Banking ASPSP search
- PSD2 bank sessions expire after ~90 days, requiring re-authentication
- Actual Budget runs as a local server (default http://localhost:5006) or remote
- @actual-app/api is the official Node.js client for Actual Budget
- Shipped v1.0 with 990 LOC JavaScript across 5 source files

## Constraints

- **Tech stack**: Node.js with ES modules, jose, @actual-app/api, ora, dotenv, telegraf, @anthropic-ai/sdk
- **Auth**: Enable Banking requires app ID + RS256 private key, then OAuth flow with browser redirect
- **Data format**: Actual Budget expects amounts in cents as integers
- **Storage**: User config in SQLite (better-sqlite3), env vars for secrets and service config

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Enable Banking over GoCardless | GoCardless disabled new signups July 2025; Enable Banking free for personal use | Good |
| Single account only | Simplicity for v1, covers primary use case | Good |
| .env for all config and state | No database needed, simple to inspect and edit | Good |
| CLI-only, no scheduling | Manual runs sufficient, avoids complexity | Good |
| URL paste for OAuth callback | Enable Banking requires HTTPS redirect; local server impractical | Good |
| jose over jsonwebtoken | ESM-native, no CommonJS issues | Good |
| Session skip on re-run | Skip bank auth when session exists in .env | Good |
| booking_date with fallback chain | Handles various date fields from different banks | Good |
| ora for CLI spinners | ESM-native, elapsed time support, clean success/fail states | Good |
| Dry-run fetches real data | User needs actual transactions to verify sync works | Good |

## Project Structure

```
src/
  index.js          — CLI entry point (sync command)
  bot.js            — Telegram bot entry point
  db.js             — SQLite user storage
  sync.js           — Transaction mapping logic
  actual.js         — Actual Budget import functions
  enablebanking.js  — Enable Banking API client
  setup.js          — CLI setup wizard
  bot/
    commands.js     — Bot command handlers (/sync, /balance, /spending, etc.)
    format.js       — Telegram message formatting helpers
    middleware.js   — Auth, typing indicator, error handling
    actual-query.js — Mutex-protected Actual API wrapper (withActual)
    setup.js        — Telegram setup/connect wizards
  agent/
    index.js        — AI agent loop (askAgent, chat history)
    tools.js        — Tool definitions and executors
    prompt.js       — System prompt builder
```

---
*Last updated: 2026-02-14 after AI agent implementation*
