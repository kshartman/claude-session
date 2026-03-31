# cs — Claude Session Manager: Build Handoff

## What We're Building

A CLI tool called `cs` (claude-sessions) that manages Claude Code sessions across
multiple Linux hosts: syncing metadata to a central MongoDB database, launching
persistent tmux-backed sessions, detecting session state, and providing cross-machine
visibility with a smart dashboard.

## Runtime & Tooling

- **Runtime**: Bun (already installed per-user at `~/.bun/bin` on all hosts)
- **Language**: TypeScript, strict mode, no `any`
- **Entry**: Single `cs.ts` with a `#!/usr/bin/env bun` shebang
- **Install**: Symlink `cs.ts` → `~/.local/bin/cs` (or equivalent on PATH)
- **MongoDB driver**: `mongodb` npm package (Bun-compatible)
- **Dependencies**: tmux (session persistence), fzf (interactive picker)

## MongoDB

- **Host**: `your-mongo-host:27017`
- **Auth**: SCRAM-SHA-256, username/password, TLS enabled
- **DB**: `claude`
- **Collection**: `sessions`
- **Connection string**: read from `~/.config/cs/config.json`

```json
{
  "mongoUri": "mongodb://claude:<password>@your-mongo-host:27017/claude?authMechanism=SCRAM-SHA-256&tls=true"
}
```

## Session Data Source

Claude Code stores sessions locally at:
```
~/.claude/projects/<path-hash>/<session-id>.jsonl
~/.claude/history.jsonl   ← global index (session id, path, timestamps)
```

The `<path-hash>` directory name is the project path with `/` replaced by `-`
(e.g. `/home/shane/projects/gstack` → `-home-shane-projects-gstack`).
Decode it by replacing leading `-` and remaining `-` with `/` — but validate
against the actual filesystem to handle edge cases.

Session JSONL files contain message objects. The first human message text is
extracted as the session title (truncated to 80 chars). If the user has set a
session name via `/rename`, the `agentName` field in the JSONL takes priority
as the session title. Session summary files may exist at:
```
~/.claude/projects/<path-hash>/<session-id>/session-memory/summary.md
```

## MongoDB Schema

```typescript
interface SessionRecord {
  _v: number;                  // schema version (current: 1) for rolling migration
  session_id: string;          // Claude's session filename stem (UUID)
  machine: string;             // os.hostname()
  project_path: string;        // decoded real path
  project_name: string;        // path.basename(project_path)
  started_at: Date;            // mtime of first message or file ctime
  updated_at: Date;            // mtime of session file
  message_count: number;       // number of lines in the JSONL
  title: string | null;        // /rename name if set, else first human message (80 chars)
  tag: string | null;          // user-applied label (only set via cs tag)
  state: SessionState | null;  // detected from tmux: WORKING | WAITING | IDLE | DEAD
  tmux_session: string | null; // tmux session name (cs-<short-id>)
  summary: string | null;      // first 200 chars of session-memory summary.md if present
  synced_at: Date;             // when this record was last upserted
}

type SessionState = "WORKING" | "WAITING" | "IDLE" | "DEAD";
```

Upsert key: `{ session_id, machine }` — idempotent, safe to run on every login.

### Indexes

- `{ session_id, machine }` — unique, upsert key
- `{ machine, updated_at: -1 }` — list query (current machine, recent first)
- `{ project_name }` — project filter

## tmux Session Management

Sessions launched via `cs launch` run Claude Code inside detached tmux sessions,
surviving SSH disconnects. tmux session naming convention:

- Has `/rename` name → use it as-is (e.g., `claude-session`)
- No rename → `<project>-<short-id>` (e.g., `trading-8ffc2399`)

### Remote Attach

`cs attach` auto-detects whether a session is local or remote by looking up the
machine field in MongoDB:

- **Local** (session machine == hostname): `exec tmux attach-session -t cs-<id>`
- **Local inside tmux**: `exec tmux switch-client -t cs-<id>` (avoids nesting)
- **Remote** (session machine != hostname): `exec ssh <machine> -t tmux attach-session -t cs-<id>`

Requires SSH key auth between machines. On detach (Ctrl-b d), the SSH connection
closes and the user returns to their local shell. The Claude session continues
running on the remote host.

Session identifiers can be: session ID prefix, `/rename` name (exact match),
or title prefix (case-insensitive).

### State Detection

State is detected by capturing the tmux pane content (`tmux capture-pane`) and
matching patterns:

| State    | Heuristic |
|----------|-----------|
| WORKING  | Claude is actively generating (spinner, streaming output) |
| WAITING  | Claude is waiting for user input (permission prompt, question) |
| IDLE     | No recent activity, session alive but quiet |
| DEAD     | tmux session no longer exists |

State detection is heuristic and must degrade gracefully — unknown patterns
produce `null` (not an error).

## Commands

```
cs                              # local dashboard: merged tmux + DB table for this machine
                                # live state overlaid, deduped, silent DB fallback

cs sync [--quiet]               # harvest ~/.claude/projects/ → upsert to MongoDB
                                # detect tmux sessions and update state
                                # --quiet suppresses output (for cron/launchctl)

cs list [--local] [--host <h>] [--project <name>] [--limit <n>]
                                # default: all hosts, sorted by updated_at desc
                                # --local: this host only
                                # output: table with columns:
                                #   MACHINE | PROJECT | TITLE | TAG | STATE | UPDATED | ID

cs launch <project> [prompt]    # start Claude in a detached tmux session
                                # optional initial prompt

cs adopt <id-or-name> [--attach]
                                # wrap existing session in managed tmux
                                # --attach: connect immediately after adopting

cs attach <id-or-name> [--host <h>]
                                # reconnect to a tmux-backed session
                                # auto-detects local vs remote from MongoDB
                                # local: tmux attach-session -t <name>
                                # local (inside tmux): tmux switch-client -t <name>
                                # remote: ssh <machine> -t tmux attach -t <name>
                                # accepts: ID prefix, /rename name, or project name
                                # ambiguous: prefers local host, or use --host to pick

cs kill <id-or-name> [--host <h>]
                                # terminate a tmux session (local or remote)
cs kill --all [--host <h>]      # kill all sessions

cs resume                       # fzf-style interactive picker → claude --resume

cs last                         # resume most recent session on this machine
                                # no picker, straight to claude --resume

cs status                       # live state of all tmux-backed sessions on this machine
                                # color-coded: green=WORKING, yellow=WAITING, dim=IDLE, red=DEAD

cs tag <id-or-name> <label>     # tag a session in MongoDB

cs info <id-or-name>            # show full record for one session

cs hosts                     # list distinct machines with session counts and last seen

cs rm <id-or-name>              # soft-delete a session (sync won't bring it back)
cs rm --undo <id-or-name>       # restore a soft-deleted session
cs prune [--days N] [--all]     # bulk soft-delete unnamed/untagged sessions
cs deleted                      # list soft-deleted sessions

cs gc [--yes]                    # find and purge compact/clear orphan sessions (local)

cs purge <pattern> [--yes]      # hard delete session + local files (irreversible)
cs purge <pattern> --all [--yes] [--host <h>] [--deleted]
                                # bulk hard delete matching sessions

cs agent stop [--host <h>] [--all]  # stop SSH agent on host(s)

cs update                       # check for new version and update in place
cs update --force               # re-download even if version matches
cs update --all                 # update all known hosts via SSH
cs version                      # print current version
```

## Color Output

- Machine names: distinct ANSI colors per machine
- Session states: green=WORKING, yellow=WAITING, dim=IDLE, red=DEAD
- Stale sessions (>24h): dimmed
- Respect `NO_COLOR` environment variable

## Undocumented Claude Code Dependencies

cs relies on undocumented internals of Claude Code that could change without
notice. All parsing is defensive (try-catch, skip malformed) so breakage
degrades gracefully rather than crashing.

| What we use | Where | Risk if changed |
|-------------|-------|-----------------|
| `~/.claude/projects/<path-hash>/<id>.jsonl` file layout | sync | Sync finds nothing |
| Path hash: `/` → `-` in directory names | sync, path decode | Projects not found |
| `type: "user"` / `type: "assistant"` in JSONL | title, message count | No titles, count=0 |
| `message.content` (string or array) | title extraction | No titles |
| `agentName` field from `/rename` | session naming | Falls back to first message |
| `timestamp` ISO string per line | started_at | Falls back to file ctime |
| `agent-*` session IDs for subagents | cleanup | Agents mixed with real sessions |
| `<id>/session-memory/summary.md` | summary extraction | No summaries |

If Claude Code publishes a stable API for session metadata, cs should migrate
to it. Until then, monitor after Claude Code updates.

## Code Structure

Two TypeScript files:

- **`lib.ts`** — Pure functions and typed interfaces (testable, no side effects):
  ```
  // --- types ---
  // --- config ---
  // --- colors ---
  // --- jsonl parsing ---
  // --- state detection ---
  // --- path decoding ---
  // --- prefix matching ---
  ```

- **`cs.ts`** — CLI entry point with shebang (imports from lib.ts):
  ```
  // --- db (connect/disconnect) ---
  // --- tmux (shell commands) ---
  // --- sync ---
  // --- commands ---
  // --- main / dispatch ---
  ```

- **`lib.test.ts`** — Unit tests for lib.ts (run via `bun test`)

No class hierarchies needed. Pure functions, typed interfaces, top-level async main.

## JSONL Parsing

Stream JSONL files line-by-line to minimize memory usage (some sessions have
thousands of messages). Only extract:
- Line count (message_count)
- First human message text (title)
- `/rename` name from `agentName` field (takes priority as title if present)

All parsing is defensive: malformed lines are skipped with a warning (verbose only),
partial tail lines (mid-write race) are silently skipped. Wrap all parsing in
try-catch with graceful degradation.

## Error Handling

- Missing config file: print setup instructions and exit 1
- MongoDB connection failure: print error with URI (redact password) and exit 1
- `~/.claude` not found: warn and exit 0 (Claude Code not installed on this host yet)
- tmux not installed: print install instructions and exit 1
- fzf not installed (for resume): print install instructions and exit 1
- Ambiguous session ID prefix: list matches and exit 1
- Unknown command: print usage and exit 1

## Install

### Remote one-liner (install-remote.sh)

Downloads `cs.bundle.js` (single bundled JS file) to `~/.local/bin/cs`:
```
curl -sSL https://raw.githubusercontent.com/kshartman/claude-session/main/install-remote.sh | bash
```

### From source (install.sh)

1. Checks `bun --version` — errors with install instructions if missing
2. Checks `tmux -V` — errors with install instructions if missing
3. Creates `~/.config/cs/` (chmod 700) and stubs `config.json` (chmod 600) if not present
4. Runs `bun install` for dependencies
5. Symlinks `cs.ts` to `~/.local/bin/cs`
6. Creates MongoDB indexes on first run
7. Sets up periodic sync (crontab on Linux, LaunchAgent on macOS)

### Build bundle

```
bun run build   # produces cs.bundle.js
```

## What NOT to Build

- No daemon / inotify watcher — sync runs via cron (Linux) or LaunchAgent (macOS) every 5 minutes
- No web UI
- No encryption of session content (metadata only, no message bodies stored)
- `cs purge` is the only command that deletes Claude's local files (JSONL + session dirs)
- No Telegram/Slack notifications — Claude Code has native channel support via MCP
- No cross-machine `cs launch` (launch is always local)

## Coding Standards

- Strict TypeScript, no `any`, typed interfaces defined once at the top
- No code duplication — shared db connect/disconnect factored out
- Session ID prefix matching shared across attach/kill/tag/info commands
- Defensive: validate decoded project paths exist on disk before upserting
- Defensive: all JSONL and tmux output parsing wrapped in try-catch
- Lint: use `bun lint` / biome if available, otherwise tsc --noEmit as a check
