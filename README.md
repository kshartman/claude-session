# cs — Claude Session Manager

Manage Claude Code sessions across multiple Linux hosts. Launch persistent sessions that survive SSH drops, see what's running everywhere, and connect to any session from any machine.

## Install

### One-liner (remote install)

On any machine with Bun and tmux:

```bash
curl -sSL https://git.bogometer.com/shartman/claude-session/-/raw/main/install-remote.sh | bash
```

Installs Bun if missing (without modifying `.bashrc`), downloads the bundled JS to `~/.local/bin/cs`, sets up config and cron sync.

Options (pass via `bash -s --`):

```bash
curl ... | bash -s -- --nocron           # skip cron setup
curl ... | bash -s -- --noconfig         # skip config copy from source host
```

### From source

```bash
git clone <repo> ~/projects/cs
cd ~/projects/cs
./install.sh
```

Edit `~/.config/cs/config.json` with your MongoDB credentials, then:

```bash
cs sync     # import your existing sessions
cs          # see the dashboard
```

### Requirements

- [Bun](https://bun.sh) runtime (auto-installed if missing)
- [tmux](https://github.com/tmux/tmux) for persistent sessions
- [fzf](https://github.com/junegunn/fzf) for interactive picker (optional, only needed for `cs resume`)
- MongoDB 5+ with TLS

### Auto-sync

The installer sets up a user cron job that syncs every 5 minutes. No `.bashrc` changes needed — your shell startup stays instant.

## Commands

### `cs`

Show the local dashboard — a single merged table of this machine's sessions with live tmux state overlaid on database records. No duplicates. Works even if MongoDB is down (shows local tmux sessions only).

### `cs sync [--quiet]`

Scan `~/.claude/projects/` for session files and upsert metadata to MongoDB. Detects tmux session states. Run this to keep the database current.

`--quiet` suppresses output (for the `.bashrc` hook).

### `cs list [--local] [--host <name>] [--project <name>] [--limit <n>]`

List sessions from the database. Defaults to all hosts, sorted by most recent.

```bash
cs list                        # all hosts
cs list --local                # this host only
cs list --host dev             # specific host
cs list --project trading      # filter by project
cs list --limit 5              # show 5 most recent
```

### `cs launch <project> [prompt]`

Start Claude Code in a detached tmux session. The session survives SSH disconnects — Claude keeps working even if you close your terminal.

```bash
cs launch myproject
cs launch myproject "fix the nginx config"
```

The output tells you the session name and how to reconnect.

### `cs adopt <id-or-name> [--attach]`

Wrap an existing Claude session in a managed tmux session. Use this to take a session you started normally and make it persistent.

```bash
cs adopt claude-session             # wrap in tmux, leave detached
cs adopt claude-session --attach    # wrap and connect immediately
cs adopt 952d --attach              # works with ID prefix too
```

### `cs attach <id-or-name> [--host <name>]`

Reconnect to a session. Works **across machines** — if the session is on a different host, cs automatically SSH's there and creates the tmux session if needed.

```bash
cs attach claude-session    # by /rename name
cs attach 952d              # by ID prefix
cs attach a4b9              # remote session — auto-SSH
cs attach onepay --host dev # disambiguate when same name on multiple hosts
```

You can use a session ID prefix (like git), a `/rename` name (exact match), or a project name. If ambiguous, cs prefers the local host's session. Use `--host` to override.

If you're already inside tmux, cs uses `switch-client` instead of nesting.

### `cs kill <id-prefix>`

Terminate a tmux session.

```bash
cs kill 952d
```

### `cs resume`

Interactive session picker using fzf. Select a session and jump straight into `claude --resume`.

### `cs last`

Resume the most recent session on this machine. No picker, no questions — straight to Claude.

### `cs status`

Live view of all active tmux sessions on this machine with their current state:

- **WORKING** (green) — Claude is actively generating
- **WAITING** (yellow) — Claude needs input or permission
- **IDLE** (dim) — session is alive but quiet
- **DEAD** (red) — tmux session no longer exists

This command reads tmux directly — no MongoDB needed.

### `cs tag <id-prefix> <label>`

Label a session for easy identification.

```bash
cs tag 952d auth-refactor
```

Tags are stored in MongoDB and show up in `cs list`.

### `cs info <id-prefix>`

Full details for a single session: ID, machine, project, title, tag, state, message count, timestamps, and schema version.

### `cs hosts`

List all hosts that have synced sessions, with session counts and when each was last seen.

### `cs rm <id-or-name>`

Soft-delete a session from MongoDB. It won't appear in listings or the dashboard, and `cs sync` won't bring it back.

```bash
cs rm "=c"                     # remove junk session by title
cs rm 262a                     # remove by ID prefix
cs rm --undo 262a              # restore a soft-deleted session
```

### `cs prune [--days N] [--all]`

Bulk soft-delete sessions that have no `/rename` name and no tag. Default threshold is 30 days.

```bash
cs prune                       # remove unnamed/untagged older than 30 days
cs prune --days 7              # older than 7 days
cs prune --all                 # all unnamed/untagged regardless of age
```

Named and tagged sessions are never pruned.

### `cs deleted [--local] [--host <name>]`

List soft-deleted sessions. Defaults to all hosts. Use `cs rm --undo <id>` to restore any of them.

### `cs purge <id-or-name> [--yes]`

Hard delete a session — removes the MongoDB record, JSONL file, and session directory. Irreversible. Without `--yes`, shows what would be deleted. Must be run on the host where the session lives.

### `cs update`

Check for a new version and update in place. Compares the local version against the remote VERSION file and downloads the new bundle if different. Also installs cron sync if not already set up (unless `noCron` is set in config).

### `cs version`

Print the current version.

## How it works

Claude Code stores sessions as JSONL files in `~/.claude/projects/`. Each file is a conversation — one JSON object per line.

`cs sync` reads these files, extracts metadata (title from your first message, message count, timestamps), and upserts to a central MongoDB database. It also checks for active tmux sessions and detects their state.

The MongoDB database is the shared layer — every machine syncs to it, and any machine can query it. Session data stays local; only metadata goes to the database.

### Session titles

Sessions are auto-titled from your first message to Claude. Instead of seeing `952dd9c9-b8ce-4e7f-...`, you see "fix the nginx config".

If you use `/rename` in Claude Code (e.g., `/rename auth-refactor`), that name takes priority and becomes both the session title and the tmux session name. You can then use it everywhere: `cs attach auth-refactor`, `cs info auth-refactor`, etc.

### Remote attach

When you `cs attach` a session that lives on a different machine, cs looks up the machine in MongoDB and runs `ssh <machine> -t tmux attach-session -t cs-<id>`. You need SSH key auth set up between machines.

### Color coding

Output is color-coded by session state and machine. Stale sessions (>24h) are dimmed. Respects the `NO_COLOR` environment variable.

## Configuration

Config lives at `~/.config/cs/config.json`:

```json
{
  "mongoUri": "mongodb://claude:<password>@your-mongo-host:27017/claude?authMechanism=SCRAM-SHA-256&tls=true",
  "showDetachHint": true
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `mongoUri` | (required) | MongoDB connection string |
| `showDetachHint` | `false` | Show detach key combo in the tmux status bar when attached |
| `listFQDN` | `true` | Show full hostnames; set `false` to show short names (e.g., `dev` instead of `dev.example.com`) |
| `noCron` | `false` | Disable automatic cron sync setup on install and update

## Multi-machine setup

1. Install cs on each machine (`curl` one-liner or clone + `./install.sh`)
2. Use the same MongoDB connection string on all machines
3. Cron sync is set up automatically by the installer
4. Set up SSH key auth between machines (for remote attach)

Now `cs list` shows sessions from all hosts, and `cs attach` connects to any of them.
