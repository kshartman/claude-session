# cs — Claude Session Manager

Manage Claude Code sessions across multiple Linux hosts. Launch persistent sessions that survive SSH drops, see what's running everywhere, and connect to any session from any machine.

## Install

```bash
git clone <repo> ~/projects/cs
cd ~/projects/cs
./install.sh
```

Edit `~/.config/cs/config.json` with your MongoDB password, then:

```bash
cs sync     # import your existing sessions
cs          # see the dashboard
```

### Requirements

- [Bun](https://bun.sh) runtime
- [tmux](https://github.com/tmux/tmux) for persistent sessions
- [fzf](https://github.com/junegunn/fzf) for interactive picker (optional, only needed for `cs resume`)
- MongoDB 5+ with TLS

### Auto-sync on login

Add to `~/.bashrc`:

```bash
cs sync --quiet &
```

This silently syncs sessions every time you open a terminal.

## Commands

### `cs`

Show the dashboard — active tmux sessions, recent sessions, anything needing attention. Works even if MongoDB is down (shows local tmux sessions only).

### `cs sync [--quiet]`

Scan `~/.claude/projects/` for session files and upsert metadata to MongoDB. Detects tmux session states. Run this to keep the database current.

`--quiet` suppresses output (for the `.bashrc` hook).

### `cs list [--all] [--machine <host>] [--project <name>] [--limit <n>]`

List sessions in a table. Defaults to current machine, sorted by most recent.

```bash
cs list                        # this machine
cs list --all                  # all machines
cs list --project trading      # filter by project
cs list --limit 5              # show 5 most recent
cs list --machine webserver    # specific machine
```

### `cs launch <project> [prompt]`

Start Claude Code in a detached tmux session. The session survives SSH disconnects — Claude keeps working even if you close your terminal.

```bash
cs launch myproject
cs launch myproject "fix the nginx config"
```

The output tells you the session name and how to reconnect.

### `cs attach <id-prefix>`

Reconnect to a session. Works **across machines** — if the session is on a different host, cs automatically SSH's there.

```bash
cs attach 952d          # local session
cs attach a4b9          # remote session — auto-SSH
```

Prefix matching works like git — type enough characters to be unique. If ambiguous, cs lists the matches.

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

### `cs machines`

List all machines that have synced sessions, with session counts and when each was last seen.

## How it works

Claude Code stores sessions as JSONL files in `~/.claude/projects/`. Each file is a conversation — one JSON object per line.

`cs sync` reads these files, extracts metadata (title from your first message, message count, timestamps), and upserts to a central MongoDB database. It also checks for tmux sessions named `cs-*` and detects their state.

The MongoDB database is the shared layer — every machine syncs to it, and any machine can query it. Session data stays local; only metadata goes to the database.

### Session titles

Sessions are auto-titled from your first message to Claude. Instead of seeing `952dd9c9-b8ce-4e7f-...`, you see "fix the nginx config".

### Remote attach

When you `cs attach` a session that lives on a different machine, cs looks up the machine in MongoDB and runs `ssh <machine> -t tmux attach-session -t cs-<id>`. You need SSH key auth set up between machines.

### Color coding

Output is color-coded by session state and machine. Stale sessions (>24h) are dimmed. Respects the `NO_COLOR` environment variable.

## Configuration

Config lives at `~/.config/cs/config.json`:

```json
{
  "mongoUri": "mongodb://claude:<password>@your-mongo-host:27017/claude?authMechanism=SCRAM-SHA-256&tls=true"
}
```

## Multi-machine setup

1. Install cs on each machine (clone + `./install.sh`)
2. Use the same MongoDB connection string on all machines
3. Add `cs sync --quiet &` to each machine's `.bashrc`
4. Set up SSH key auth between machines (for remote attach)

Now `cs list --all` shows sessions from everywhere, and `cs attach` connects to any of them.
