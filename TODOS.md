# TODOS

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
