# cs — Claude Session Manager

Manage Claude Code sessions across multiple Linux hosts. Launch persistent sessions that survive SSH drops, see what's running everywhere, and connect to any session from any machine.

## Install

### One-liner (remote install)

On any machine with Bun and tmux:

```bash
curl -sSL https://raw.githubusercontent.com/kshartman/claude-session/main/install-remote.sh | bash
```

Installs Bun if missing (without modifying `.bashrc`), downloads the bundled JS to `~/.local/bin/cs` — verifying it against its published SHA-256 checksum — and sets up config and cron sync.

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
- [Claude Code](https://claude.ai/code) CLI (`claude`)
- MongoDB 5+ with TLS

**PATH requirement:** `bun`, `tmux`, and `claude` must be on PATH for **non-interactive** login shells (e.g., `ssh host 'which tmux'` must work). Remote attach and cron sync run without a terminal. If your PATH is set inside an interactive guard in `.bashrc`, move it to `.bash_profile` before the `.bashrc` source. This is especially important on macOS where Homebrew paths (`/opt/homebrew/bin`) may not be set for non-interactive shells.

**SSH keys:** Each machine needs your SSH private key on disk. cs manages a persistent local agent (`~/.ssh/cs-agent.sock`) — no agent forwarding or dotfile configuration required. See [docs/ssh-agent-setup.md](docs/ssh-agent-setup.md) for the full agent model, timeout behavior, and options.

### Auto-sync

The installer sets up periodic sync every 5 minutes — crontab on Linux, LaunchAgent on macOS. No `.bashrc` changes needed — your shell startup stays instant.

## Commands

<!-- BEGIN GENERATED COMMANDS — edit commands.ts, run: bun scripts/gen-docs.ts -->
### `cs [--sort [field]] [--orphans]`

Display the local dashboard: a single merged table of this machine's sessions with live tmux state overlaid on database records. No duplicates. Falls back to a tmux-only display if MongoDB is unreachable.

With `--orphans`, also lists untracked tmux sessions that are running Claude but have no database record (e.g. sessions started manually outside cs).

`--sort [field]` orders the table as in `cs list`. The other `cs list` options do not apply to the dashboard.

### `cs sync [--quiet]`

Harvest session metadata from `~/.claude/projects/` and upsert it to MongoDB. Detects active tmux sessions and their state.

With `--quiet`, suppresses all output — this is the form the periodic cron/LaunchAgent sync runs.

### `cs list [--local] [--host <name>] [--project <name>] [--limit <n>] [--sort [field]]`

List sessions from the database, most recently updated first. Defaults to all hosts.

- `--sort [field]` — Sort by `title`, `updated`, `host`, or `project` (`--sort` alone sorts by title). Ties are broken by the remaining fields in that order.
- `--local` — Show sessions from this host only.
- `--host <name>` — Filter to a specific host. Accepts short names (e.g. `dev` matches `dev.example.com`).
- `--project <name>` — Filter by project name.
- `--limit <n>` — Maximum number of results (default: 40).

```bash
cs list                        # all hosts
cs list --local                # this host only
cs list --host dev             # specific host
cs list --project myapp        # filter by project
cs list --limit 5              # show 5 most recent
cs list --sort project         # sort by project name
```

### `cs launch <project> [prompt]`

Start Claude Code in a detached tmux session. The session survives SSH disconnects — Claude keeps working even if you close your terminal. If `prompt` is given, it is passed to Claude as the initial message.

The output tells you the session name and how to reconnect.

```bash
cs launch myproject
cs launch myproject "fix the nginx config"
```

### `cs adopt <id-or-name> [--attach]`

Wrap an existing Claude session in a managed tmux session — use this to take a session you started normally and make it persistent. The session is resumed via `claude --resume` inside a detached tmux. With `--attach`, connects immediately after adopting.

```bash
cs adopt claude-session             # wrap in tmux, leave detached
cs adopt claude-session --attach    # wrap and connect immediately
cs adopt 952d --attach              # works with ID prefix too
```

### `cs attach <id-or-name> [--host <name>] [--latest]`

Reconnect to a session. If it is on the local machine, attaches to its tmux session directly; if you are already inside tmux, uses `switch-client` to avoid nesting. If it is on a remote machine, cs ssh's there, creates the tmux session if needed, and attaches. Requires SSH key authentication for remote sessions.

Sessions can be identified by ID prefix (like git), `/rename` name (exact match), or project name. When ambiguous, cs prefers the local host's session; use `--host` to disambiguate explicitly.

If the matches are still ambiguous but all belong to the same project, cs lists them newest first and asks which to attach; pressing Enter picks the most recently active. `--latest` skips the question and attaches to the most recently active one (required when stdin is not a terminal). Matches spanning several projects are always an error.

```bash
cs attach claude-session    # by /rename name
cs attach 952d              # by ID prefix
cs attach a4b9              # remote session — auto-SSH
cs attach myapp --host dev  # disambiguate when same name on multiple hosts
cs attach myapp --latest    # several myapp sessions — take the newest
```

### `cs kill <id-or-name> [--host <name>]`

Terminate a tmux session, local or remote via SSH. Updates the session state in MongoDB immediately. With `--all`, kills every active session, optionally filtered to one host.

```bash
cs kill claude-session            # kill by name
cs kill 952d                      # kill by ID prefix
cs kill myapp --host host1        # explicit host
cs kill --all                     # kill all sessions everywhere
cs kill --all --host dev          # kill all sessions on dev
```

### `cs kill --all [--host <name>]`

Kill all active sessions. Optionally filter to a specific host.

### `cs resume`

Interactive session picker using fzf. Displays recent sessions from the current machine and launches `claude --resume` for the one you select.

### `cs last`

Resume the most recent session on this machine — no picker, straight to Claude. Equivalent to selecting the first item in `cs resume`.

### `cs status`

Display the live state of every active cs tmux session on this machine. Reads tmux directly; does not require MongoDB.

- **WORKING** — (green) Claude is actively generating output.
- **WAITING** — (yellow) Claude is waiting for user input or permission.
- **IDLE** — (dim) Session is alive but has no recent activity.
- **DEAD** — (red) tmux session no longer exists.

### `cs tag <id-or-name> <label>`

Apply a text label to a session for easy identification. Tags are stored in MongoDB and shown in `cs list` output.

```bash
cs tag 952d auth-refactor
```

### `cs info <id-or-name>`

Display the full record for a single session: session ID, machine, project path, title, `/rename` name (if any), tag, state, message count, timestamps, tmux session name, summary, and schema version.

### `cs hosts`

List every known host: its live (not soft-deleted) session count, when a session there was last active, when the host last ran `cs sync`, and the cs version it runs. Hosts register themselves on every sync, so a host with no sessions is still listed; `old` means it has not synced since upgrading to a cs that registers hosts.

### `cs rm <id-or-name>`

Soft-delete a session: the record is marked with a `deleted_at` timestamp, so it no longer appears in listings, queries, or sync — and `cs sync` will not bring it back. Local files are untouched. `cs rm --undo` restores it.

```bash
cs rm "=c"                     # remove junk session by title
cs rm 262a                     # remove by ID prefix
cs rm --undo 262a              # restore a soft-deleted session
```

### `cs rm --undo <id-or-name>`

Restore a soft-deleted session.

### `cs prune [--days N] [--all]`

Bulk soft-delete sessions that have no `/rename` name and no tag. Default threshold is 30 days; `--all` prunes regardless of age. **Named, tagged, and running sessions are never pruned.**

```bash
cs prune                       # remove unnamed/untagged older than 30 days
cs prune --days 7              # older than 7 days
cs prune --all                 # all unnamed/untagged regardless of age
```

### `cs deleted [--local] [--host <name>]`

List soft-deleted sessions with their deletion timestamps. Defaults to all hosts. Restore any of them with `cs rm --undo <id>`.

### `cs gc [--yes]`

Collapse duplicate sessions. Sessions are grouped by project and host; the most recently updated one in each group is kept and the older ones become GC candidates. **An older session that is still running in tmux is never removed** — it is listed as kept instead. Without `--yes`, shows what would be removed.

This is a soft-delete — no local files are touched, and anything removed can be restored with `cs rm --undo <id>`.

```bash
cs gc                          # preview the duplicates that would be removed
cs gc --yes                    # soft-delete them
```

### `cs purge <pattern>... [--yes] [--all] [--host <name>] [--deleted]`

Hard delete sessions — removes MongoDB records, JSONL files, and session directories, and stops the session's tmux session only if it is the session running there (never another session that merely shares its name). **Irreversible.** Without `--yes`, shows what would be deleted.

Sessions on other hosts are purged there over ssh, after the one confirmation given here: each host is sent the exact session IDs you saw, never the pattern, so it cannot widen the set. A host that cannot be reached is reported and its sessions are left alone; cs then exits 1.

Several sessions can be named at once (`cs purge --yes s1 s2 s3`). Each is resolved independently; one that does not resolve is reported and skipped rather than aborting the batch.

With `--all`, bulk deletes matching sessions (requires typed `YES` confirmation). Bulk mode **skips live `/rename`d or tagged sessions** unless they have already been soft-deleted — a wildcard cannot silently destroy a session you named or tagged. To purge one anyway, target it explicitly or soft-delete it first. Bulk mode also **never touches a session that is running in tmux**, soft-deleted or not. With `--deleted`, targets only soft-deleted sessions.

```bash
cs purge 952d                      # preview single session purge
cs purge 952d --yes                # purge one session
cs purge --yes 952d a4b9 262a      # purge several at once
cs purge agent --all --yes         # bulk purge all matching "agent"
cs purge --all --deleted --yes     # empty the trash on every host
cs purge --all --host dev --yes    # purge all sessions on dev (over SSH)
```

### `cs purge --orphans [--yes]`

Remove orphaned local state on this machine: `~/.claude/projects/` directories whose decoded project path no longer exists on disk (the dirs `cs sync` skips with a `cannot decode path` warning), plus DB records on this host that point at a missing project path. This is the cleanup for the cruft those skip-warnings flag.

Without `--yes`, lists what was found; removing more than one item also requires a typed `YES`, same as `purge --all`.

Honors the same keep-signal guard as bulk purge: a **live `/rename`d or tagged** session whose project path is gone (e.g. a transiently unmounted drive) is listed but **kept** — target it explicitly with `cs purge <name>` to remove it. Local-only and irreversible.

```bash
cs purge --orphans                 # preview orphaned dirs + stale records
cs purge --orphans --yes           # remove them
```

### `cs add-key [--host <name>] [--all]`

Load your SSH key into the shared cs agent and reset its lifetime, prompting for the passphrase if needed. The agent is started only when its socket is dead; a live agent is never killed.

Every cs session on a host shares one agent, so a single call covers all of them — run it when the key timer has expired and SSH starts failing. `--host` runs it on a remote host; `--all` on every known host.

```bash
cs add-key                 # this machine
cs add-key --host dev      # a specific host
cs add-key --all           # every known host
```

### `cs agent stop [--host <name>] [--all]`

Kill the persistent SSH agent on one or all machines — useful when you are done for the day and want keys out of memory. The agent runs at `~/.ssh/cs-agent.sock` and is started automatically by `cs attach`.

Because the agent is shared, stopping it cuts SSH access for every cs session on that host at once.

### `cs update [--force] [--all]`

Check for a new version on the remote server and, if one is available, download the updated bundle and man page. `--force` re-downloads even when the version matches; `--all` updates all known hosts via SSH after updating locally — every host registered by `cs sync`, even one with no sessions, plus hosts with sessions that have not registered yet. A registered host that has not synced in 30 days is skipped and named. Also installs the periodic sync if it is not set up (unless `noCron` is set in config).

The downloaded bundle is verified against its published SHA-256 checksum before it replaces the running binary. A missing, malformed, or mismatched checksum aborts the update and leaves the current binary untouched.

On its own, that checksum comes from the same origin as the bundle, so it catches a corrupted download but not a compromised repo. Set `mirrorUrl` in config (or `CS_MIRROR_URL`) to a second, independent host serving the same files: the update then proceeds only if both origins publish the identical checksum, and aborts if the mirror is unreachable, disagrees, or is on the same host as the primary.

### `cs version`, `--version`

Print the current version and exit.
<!-- END GENERATED COMMANDS -->

## How it works

Claude Code stores sessions as JSONL files in `~/.claude/projects/`. Each file is a conversation — one JSON object per line.

`cs sync` reads these files, extracts metadata (title from your first message, message count, timestamps), and upserts to a central MongoDB database. It also checks for active tmux sessions and detects their state.

The MongoDB database is the shared layer — every machine syncs to it, and any machine can query it. Session data stays local; only metadata goes to the database.

### Session titles

Sessions are auto-titled from your first message to Claude. Instead of seeing `952dd9c9-b8ce-4e7f-...`, you see "fix the nginx config".

If you use `/rename` in Claude Code (e.g., `/rename auth-refactor`), that name takes priority and becomes both the session title and the tmux session name. You can then use it everywhere: `cs attach auth-refactor`, `cs info auth-refactor`, etc.

### Remote attach

When you `cs attach` a session that lives on a different machine, cs SSH's to that host, creates the tmux session if needed, and attaches. cs manages a persistent SSH agent on each machine (`~/.ssh/cs-agent.sock`) — no agent forwarding, no symlinks, no dotfile configuration needed. If keys have expired, cs prompts for your passphrase before attaching.

Use `cs agent stop` to kill the agent on any machine when you're done.

### Color coding

Output is color-coded by session state and machine. Stale sessions (>24h) are dimmed. Color is used only when stdout and stderr are both terminals; `NO_COLOR` disables it, and `FORCE_COLOR` enables it for pipes (`cs list | less -R`).

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
| `noCron` | `false` | Disable automatic cron sync setup on install and update |
| `remotePath` | `$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin` | Extra PATH entries for remote SSH commands (tmux, claude) |
| `agentKeyTimeout` | `28800` (8h) | How long SSH keys stay loaded in the agent (seconds) |
| `agentKeyFile` | (unset) | Which SSH private key to load into the agent. Unset means plain `ssh-add`, i.e. ssh's default key set. Supports `~`. |
| `hostname` | `os.hostname()` | Override the stored hostname. Use when `os.hostname()` changes (e.g., short name → FQDN) to keep records consistent. Sync auto-migrates old records. |
| `repoUrl` | GitHub repo URL | Override the base URL for update/install downloads |
| `mirrorUrl` | (unset) | A second, independent origin serving the same release files. When set, `cs update` requires both origins to publish the identical bundle checksum and refuses otherwise. For a fresh install, pass it as `CS_MIRROR_URL` to `install-remote.sh`. |

## Multi-machine setup

1. Install cs on each machine (`curl` one-liner or clone + `./install.sh`)
2. Use the same MongoDB connection string on all machines
3. Cron sync is set up automatically by the installer
4. Set up SSH key auth between machines (for remote attach)

Now `cs list` shows sessions from all hosts, and `cs attach` connects to any of them.
