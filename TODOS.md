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
