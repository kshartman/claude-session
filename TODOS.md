# TODOS

## ~~P1 — Background sync via user cron instead of .bashrc~~
**Completed:** v1.3.8 (2026-03-21)

## P2 — Cross-session memory
Store key decisions, architecture notes, and debugging findings in the `memory`
collection that persist across Claude sessions. Claude could query this to avoid
re-discovering context.

**Why:** 12-month vision — "never lose context." Sessions end, but knowledge shouldn't.
**Context:** The `memory` collection already exists in the `claude` DB. Schema design
is unclear until real-world usage reveals what's worth remembering. Start by observing
what you wish you'd remembered between sessions.
**Effort:** M human / S CC (~30 min)
**Depends on:** Core cs shipped and in daily use.

## P2 — `cs search <query>`
Full-text search across session titles, summaries, and tags using MongoDB text indexes.

**Why:** With hundreds of sessions across machines, finding "that session where I
debugged the auth middleware" by keyword.
**Context:** Requires a MongoDB text index on `{ title, summary, tag }`. Query syntax
TBD — could be simple substring or full MongoDB text search with relevance scoring.
**Effort:** S (CC ~15 min)
**Depends on:** Auto-titles and summaries must be populated by sync.

## P3 — Slack webhook integration
Post session state changes to a Slack channel via incoming webhook. Non-interactive,
read-only status feed for team visibility or a monitoring dashboard.

**Why:** Team visibility beyond the person running cs.
**Context:** Simple HTTP POST to Slack incoming webhook URL. Add `slackWebhookUrl` to
config.json. Fire on state transitions: started, finished, waiting, error.
**Effort:** S (CC ~15 min)
**Depends on:** Core cs shipped. State detection working.

## P3 — Shell completions
Tab-complete session ID prefixes, command names, and project names for bash/zsh.

**Why:** CLI UX polish for daily use. Tab-completing partial session IDs is much faster
than copy-pasting UUIDs.
**Context:** Separate completion scripts per shell. install.sh needs to register them
(e.g., source from .bashrc). Bun may have completion generation helpers.
**Effort:** S (CC ~15 min)
**Depends on:** Core cs commands working.

## P1 — MCP server + skill for direct session reporting
Replace JSONL parsing and tmux state detection with Claude self-reporting
via an MCP server. Claude calls tools to register, heartbeat, and summarize
— data goes straight to MongoDB with no heuristics.

**Why:** Eliminates all undocumented Claude Code JSONL dependencies. State
detection becomes authoritative (Claude says "I'm WAITING") instead of
heuristic (regex on tmux pane content). Real-time instead of 5-minute cron.
**Context:** Two components:
1. **MCP server** — runs locally, exposes `session_register`, `session_heartbeat`,
   `session_summary` tools. Writes to MongoDB directly. Configured in `.mcp.json`
   or `~/.claude.json` so every Claude session connects to it.
2. **Global CLAUDE.md instruction** — tells Claude to call the MCP tools on startup,
   on state change, and on task completion. Goes in `~/.claude/CLAUDE.md`.

What it replaces: `cs sync` JSONL parsing, tmux `capture-pane` state detection,
title extraction, summary parsing. What stays: tmux management, CLI commands,
cross-machine visibility. Cron sync becomes a fallback for sessions not using
the MCP.
**Effort:** M human / S CC (~45 min)
**Depends on:** Claude Code MCP support (already available in v2.1.80+).

## P2 — Pluggable storage backend (SessionStore abstraction)
Abstract the MongoDB dependency behind a `SessionStore` interface so cs can
support multiple storage backends.

**Why:** MongoDB requires self-hosting. Most users want zero-infrastructure
setup (SQLite) or serverless cloud (DynamoDB). Pluggable storage makes cs
accessible to everyone.
**Context:** Define a `SessionStore` interface with `upsert`, `find`, `delete`,
`aggregate` methods. Three implementations:

| Store | Setup | Multi-machine | Best for |
|-------|-------|---------------|----------|
| SQLite | Zero (file) | No (single machine) | Solo users, getting started |
| DynamoDB | AWS account | Yes (serverless) | Cloud-native teams |
| MongoDB | Self-hosted or Atlas free tier | Yes | Multi-machine users |

Config selects the backend:
```json
{ "store": "sqlite" }
{ "store": "dynamodb", "awsRegion": "us-east-1", "tableName": "cs-sessions" }
{ "store": "mongodb", "mongoUri": "..." }
```
Default: SQLite (zero config, works out of the box). Current behavior preserved
when `mongoUri` is present (implicit MongoDB mode for backward compat).
**Effort:** L human / M CC (~1 hr)
**Depends on:** Nothing — can be done anytime. SQLite first, DynamoDB second.

## P3 — Config sync on update
When `cs update` runs, check if the remote config has new keys that the local
config doesn't have. Warn or merge new defaults without overwriting existing values.

**Why:** If a new version adds a config option that must be set, machines running
`cs update` silently get the new binary but miss the config change.
**Context:** Currently `cs update` only replaces the bundle and man page. Config
is copied from a source host at install time (`scp` from `CS_CONFIG_HOST`) but
never updated after that. A lightweight approach: fetch a `config.defaults.json`
from the repo, diff keys against local config, print warnings for missing keys.
**Effort:** S (CC ~15 min)
**Depends on:** A config change that actually requires propagation (none yet).
