// Single source of truth for the CLI surface.
//
// `cs --help` renders from this table at runtime (printUsage in cs.ts), and
// `bun scripts/gen-docs.ts` renders the COMMANDS section of cs.1 and the
// "## Commands" section of README.md from it at build time. Change a flag or a
// behavior here and all three follow; `bun run check` fails if the generated
// docs have drifted.
//
// Prose markup is deliberately tiny: `literal` for code/flags/paths, **bold**
// for emphasis, and name(1) for man-page cross references. Everything else is
// plain text — see scripts/gen-docs.ts for how each renders.
//
// Field routing:
//   summary   → `cs --help` only (omit to hide the entry from --help)
//   variants  → extra `cs --help` lines; also man + README when inDocs is set
//   details   → man page + README
//   options   → man page + README
//   examples  → README only (cs.1 keeps its own hand-written EXAMPLES section)

import type { ArgSpec } from "./lib";

export interface DefItem {
  /** Flag or label, e.g. "--host <name>" or "WORKING". */
  term: string;
  /** Terse form for `cs --help`; falls back to `desc` when absent. */
  help?: string;
  /** Full prose for the man page and README. */
  desc: string;
}

export type DocBlock = { p: string } | { defs: DefItem[] };

/** Another documented spelling of a command, e.g. `cs kill --all`. */
export interface CommandVariant {
  name: string;
  args?: string;
  /** Terse line for `cs --help`. */
  summary: string;
  /**
   * Give the variant its own entry in the man page and README, using `desc` if
   * present and `summary` otherwise. Leave unset for spellings the parent's
   * prose already covers — they stay help-only lines.
   */
  inDocs?: boolean;
  desc?: string;
}

export interface CommandDoc {
  /** Stable key, unique across the table. */
  id: string;
  /** Command name, bolded in the man page, e.g. "cs purge". */
  name: string;
  /** Argument/flag string, italicized in the man page. */
  args?: string;
  /** Equivalent spelling, e.g. "--version" for `cs version`. */
  alias?: string;
  /** Condensed args for the terse `cs --help` line; defaults to `args`. */
  helpArgs?: string;
  summary?: string;
  variants?: CommandVariant[];
  details: DocBlock[];
  options?: DefItem[];
  /**
   * Name of the command whose options this one shares. Renders as a pointer
   * instead of repeating the list, so the flags still have exactly one home.
   */
  optionsFrom?: string;
  examples?: string[];
}

/**
 * Options of `cs list` (the dashboard takes only `--sort` of these), printed by
 * `cs --help` under "List options".
 */
export const LIST_OPTIONS: DefItem[] = [
  {
    term: "--sort [field]",
    help: "Sort by: title, updated, host, project (default: title)",
    desc: "Sort by `title`, `updated`, `host`, or `project` (`--sort` alone sorts by title). Ties are broken by the remaining fields in that order.",
  },
  {
    term: "--local",
    help: "This host only",
    desc: "Show sessions from this host only.",
  },
  {
    term: "--host <name>",
    help: "Filter by host",
    desc: "Filter to a specific host. Accepts short names (e.g. `dev` matches `dev.example.com`).",
  },
  {
    term: "--project <name>",
    help: "Filter by project",
    desc: "Filter by project name.",
  },
  {
    term: "--limit <n>",
    help: "Max results (default: 40)",
    desc: "Maximum number of results (default: 40).",
  },
];

export const COMMANDS: CommandDoc[] = [
  {
    id: "dashboard",
    name: "cs",
    args: "[--sort [field]] [--orphans]",
    summary: "Smart dashboard (--orphans: show untracked claude tmux sessions)",
    details: [
      {
        p: "Display the local dashboard: a single merged table of this machine's sessions with live tmux state overlaid on database records. No duplicates. Falls back to a tmux-only display if MongoDB is unreachable.",
      },
      {
        p: "With `--orphans`, also lists untracked tmux sessions that are running Claude but have no database record (e.g. sessions started manually outside cs).",
      },
      {
        p: "`--sort [field]` orders the table as in `cs list`. The other `cs list` options do not apply to the dashboard.",
      },
    ],
  },
  {
    id: "sync",
    name: "cs sync",
    args: "[--quiet]",
    summary: "Sync sessions to MongoDB",
    details: [
      {
        p: "Harvest session metadata from `~/.claude/projects/` and upsert it to MongoDB. Detects active tmux sessions and their state.",
      },
      {
        p: "With `--quiet`, suppresses all output — this is the form the periodic cron/LaunchAgent sync runs.",
      },
    ],
  },
  {
    id: "list",
    name: "cs list",
    args: "[--local] [--host <name>] [--project <name>] [--limit <n>] [--sort [field]]",
    helpArgs: "[options]",
    summary: "List sessions",
    details: [
      {
        p: "List sessions from the database, most recently updated first. Defaults to all hosts.",
      },
    ],
    options: LIST_OPTIONS,
    examples: [
      "cs list                        # all hosts",
      "cs list --local                # this host only",
      "cs list --host dev             # specific host",
      "cs list --project myapp        # filter by project",
      "cs list --limit 5              # show 5 most recent",
      "cs list --sort project         # sort by project name",
    ],
  },
  {
    id: "launch",
    name: "cs launch",
    args: "<project> [prompt]",
    summary: "Launch Claude in detached tmux",
    details: [
      {
        p: "Start Claude Code in a detached tmux session. The session survives SSH disconnects — Claude keeps working even if you close your terminal. If `prompt` is given, it is passed to Claude as the initial message.",
      },
      { p: "The output tells you the session name and how to reconnect." },
    ],
    examples: [
      "cs launch myproject",
      'cs launch myproject "fix the nginx config"',
    ],
  },
  {
    id: "adopt",
    name: "cs adopt",
    args: "<id-or-name> [--attach]",
    summary: "Wrap existing session in managed tmux",
    details: [
      {
        p: "Wrap an existing Claude session in a managed tmux session — use this to take a session you started normally and make it persistent. The session is resumed via `claude --resume` inside a detached tmux. With `--attach`, connects immediately after adopting.",
      },
    ],
    examples: [
      "cs adopt claude-session             # wrap in tmux, leave detached",
      "cs adopt claude-session --attach    # wrap and connect immediately",
      "cs adopt 952d --attach              # works with ID prefix too",
    ],
  },
  {
    id: "attach",
    name: "cs attach",
    args: "<id-or-name> [--host <name>] [--latest]",
    summary: "Attach to session (local or remote)",
    details: [
      {
        p: "Reconnect to a session. If it is on the local machine, attaches to its tmux session directly; if you are already inside tmux, uses `switch-client` to avoid nesting. If it is on a remote machine, cs ssh(1)'s there, creates the tmux session if needed, and attaches. Requires SSH key authentication for remote sessions.",
      },
      {
        p: "Sessions can be identified by ID prefix (like git(1)), `/rename` name (exact match), or project name. When ambiguous, cs prefers the local host's session; use `--host` to disambiguate explicitly.",
      },
      {
        p: "If the matches are still ambiguous but all belong to the same project, cs lists them newest first and asks which to attach; pressing Enter picks the most recently active. `--latest` skips the question and attaches to the most recently active one (required when stdin is not a terminal). Matches spanning several projects are always an error.",
      },
    ],
    examples: [
      "cs attach claude-session    # by /rename name",
      "cs attach 952d              # by ID prefix",
      "cs attach a4b9              # remote session — auto-SSH",
      "cs attach myapp --host dev  # disambiguate when same name on multiple hosts",
      "cs attach myapp --latest    # several myapp sessions — take the newest",
    ],
  },
  {
    id: "kill",
    name: "cs kill",
    args: "<id-or-name> [--host <name>]",
    summary: "Kill a tmux session (local or remote)",
    variants: [
      {
        name: "cs kill --all",
        args: "[--host <name>]",
        summary: "Kill all sessions (optionally on one host)",
        inDocs: true,
        desc: "Kill all active sessions. Optionally filter to a specific host.",
      },
    ],
    details: [
      {
        p: "Terminate a tmux session, local or remote via SSH. Updates the session state in MongoDB immediately. With `--all`, kills every active session, optionally filtered to one host.",
      },
    ],
    examples: [
      "cs kill claude-session            # kill by name",
      "cs kill 952d                      # kill by ID prefix",
      "cs kill myapp --host host1        # explicit host",
      "cs kill --all                     # kill all sessions everywhere",
      "cs kill --all --host dev          # kill all sessions on dev",
    ],
  },
  {
    id: "resume",
    name: "cs resume",
    summary: "Interactive session picker (fzf)",
    details: [
      {
        p: "Interactive session picker using fzf(1). Displays recent sessions from the current machine and launches `claude --resume` for the one you select.",
      },
    ],
  },
  {
    id: "last",
    name: "cs last",
    summary: "Resume most recent session",
    details: [
      {
        p: "Resume the most recent session on this machine — no picker, straight to Claude. Equivalent to selecting the first item in `cs resume`.",
      },
    ],
  },
  {
    id: "status",
    name: "cs status",
    summary: "Live tmux session states",
    details: [
      {
        p: "Display the live state of every active cs tmux session on this machine. Reads tmux directly; does not require MongoDB.",
      },
      {
        defs: [
          { term: "WORKING", desc: "(green) Claude is actively generating output." },
          { term: "WAITING", desc: "(yellow) Claude is waiting for user input or permission." },
          { term: "IDLE", desc: "(dim) Session is alive but has no recent activity." },
          { term: "DEAD", desc: "(red) tmux session no longer exists." },
        ],
      },
    ],
  },
  {
    id: "tag",
    name: "cs tag",
    args: "<id-or-name> <label>",
    summary: "Tag a session",
    details: [
      {
        p: "Apply a text label to a session for easy identification. Tags are stored in MongoDB and shown in `cs list` output.",
      },
    ],
    examples: ["cs tag 952d auth-refactor"],
  },
  {
    id: "info",
    name: "cs info",
    args: "<id-or-name>",
    summary: "Show session details",
    details: [
      {
        p: "Display the full record for a single session: session ID, machine, project path, title, `/rename` name (if any), tag, state, message count, timestamps, tmux session name, summary, and schema version.",
      },
    ],
  },
  {
    id: "hosts",
    name: "cs hosts",
    summary: "List hosts with session counts",
    details: [
      {
        p: "List every known host: its live (not soft-deleted) session count, when a session there was last active, when the host last ran `cs sync`, and the cs version it runs. Hosts register themselves on every sync, so a host with no sessions is still listed; `old` means it has not synced since upgrading to a cs that registers hosts.",
      },
    ],
  },
  {
    id: "rm",
    name: "cs rm",
    args: "<id-or-name>",
    summary: "Soft-delete a session",
    variants: [
      {
        name: "cs rm --undo",
        args: "<id-or-name>",
        summary: "Restore a soft-deleted session",
        inDocs: true,
        desc: "Restore a soft-deleted session.",
      },
    ],
    details: [
      {
        p: "Soft-delete a session: the record is marked with a `deleted_at` timestamp, so it no longer appears in listings, queries, or sync — and `cs sync` will not bring it back. Local files are untouched. `cs rm --undo` restores it.",
      },
    ],
    examples: [
      'cs rm "=c"                     # remove junk session by title',
      "cs rm 262a                     # remove by ID prefix",
      "cs rm --undo 262a              # restore a soft-deleted session",
    ],
  },
  {
    id: "prune",
    name: "cs prune",
    args: "[--days N] [--all]",
    summary: "Bulk soft-delete unnamed/untagged sessions",
    details: [
      {
        p: "Bulk soft-delete sessions that have no `/rename` name and no tag. Default threshold is 30 days; `--all` prunes regardless of age. **Named, tagged, and running sessions are never pruned.**",
      },
    ],
    examples: [
      "cs prune                       # remove unnamed/untagged older than 30 days",
      "cs prune --days 7              # older than 7 days",
      "cs prune --all                 # all unnamed/untagged regardless of age",
    ],
  },
  {
    id: "deleted",
    name: "cs deleted",
    args: "[--local] [--host <name>]",
    summary: "List soft-deleted sessions",
    details: [
      {
        p: "List soft-deleted sessions with their deletion timestamps. Defaults to all hosts. Restore any of them with `cs rm --undo <id>`.",
      },
    ],
  },
  {
    id: "gc",
    name: "cs gc",
    args: "[--yes]",
    helpArgs: "",
    summary: "List duplicate sessions (same project+host, older ones)",
    variants: [{ name: "cs gc --yes", summary: "Soft-delete the duplicates" }],
    details: [
      {
        p: "Collapse duplicate sessions. Sessions are grouped by project and host; the most recently updated one in each group is kept and the older ones become GC candidates. **An older session that is still running in tmux is never removed** — it is listed as kept instead. Without `--yes`, shows what would be removed.",
      },
      {
        p: "This is a soft-delete — no local files are touched, and anything removed can be restored with `cs rm --undo <id>`.",
      },
    ],
    examples: [
      "cs gc                          # preview the duplicates that would be removed",
      "cs gc --yes                    # soft-delete them",
    ],
  },
  {
    id: "purge",
    name: "cs purge",
    args: "<pattern>... [--yes] [--all] [--host <name>] [--deleted]",
    helpArgs: "<pattern>... [--yes]",
    summary: "Hard delete one or more sessions + local files (irreversible)",
    variants: [
      {
        name: "cs purge <pattern> --all",
        args: "[--yes] [--host <name>] [--deleted]",
        summary: "Bulk hard delete (skips live named/tagged sessions)",
      },
    ],
    details: [
      {
        p: "Hard delete sessions — removes MongoDB records, JSONL files, and session directories, and stops the session's tmux session only if it is the session running there (never another session that merely shares its name). **Irreversible.** Without `--yes`, shows what would be deleted.",
      },
      {
        p: "Sessions on other hosts are purged there over ssh(1), after the one confirmation given here: each host is sent the exact session IDs you saw, never the pattern, so it cannot widen the set. A host that cannot be reached is reported and its sessions are left alone; cs then exits 1.",
      },
      {
        p: "Several sessions can be named at once (`cs purge --yes s1 s2 s3`). Each is resolved independently; one that does not resolve is reported and skipped rather than aborting the batch.",
      },
      {
        p: "With `--all`, bulk deletes matching sessions (requires typed `YES` confirmation). Bulk mode **skips live `/rename`d or tagged sessions** unless they have already been soft-deleted — a wildcard cannot silently destroy a session you named or tagged. To purge one anyway, target it explicitly or soft-delete it first. Bulk mode also **never touches a session that is running in tmux**, soft-deleted or not. With `--deleted`, targets only soft-deleted sessions.",
      },
    ],
    examples: [
      "cs purge 952d                      # preview single session purge",
      "cs purge 952d --yes                # purge one session",
      "cs purge --yes 952d a4b9 262a      # purge several at once",
      'cs purge agent --all --yes         # bulk purge all matching "agent"',
      "cs purge --all --deleted --yes     # empty the trash on every host",
      "cs purge --all --host dev --yes    # purge all sessions on dev (over SSH)",
    ],
  },
  {
    id: "purge-orphans",
    name: "cs purge --orphans",
    args: "[--yes]",
    summary: "Remove ~/.claude/projects/ dirs whose project path is gone",
    details: [
      {
        p: "Remove orphaned local state on this machine: `~/.claude/projects/` directories whose decoded project path no longer exists on disk (the dirs `cs sync` skips with a `cannot decode path` warning), plus DB records on this host that point at a missing project path. This is the cleanup for the cruft those skip-warnings flag.",
      },
      {
        p: "Without `--yes`, lists what was found; removing more than one item also requires a typed `YES`, same as `purge --all`.",
      },
      {
        p: "Honors the same keep-signal guard as bulk purge: a **live `/rename`d or tagged** session whose project path is gone (e.g. a transiently unmounted drive) is listed but **kept** — target it explicitly with `cs purge <name>` to remove it. Local-only and irreversible.",
      },
    ],
    examples: [
      "cs purge --orphans                 # preview orphaned dirs + stale records",
      "cs purge --orphans --yes           # remove them",
    ],
  },
  {
    id: "add-key",
    name: "cs add-key",
    args: "[--host <name>] [--all]",
    summary: "Reload SSH key into cs-agent (resets the key timer)",
    details: [
      {
        p: "Load your SSH key into the shared cs agent and reset its lifetime, prompting for the passphrase if needed. The agent is started only when its socket is dead; a live agent is never killed.",
      },
      {
        p: "Every cs session on a host shares one agent, so a single call covers all of them — run it when the key timer has expired and SSH starts failing. `--host` runs it on a remote host; `--all` on every known host.",
      },
    ],
    examples: [
      "cs add-key                 # this machine",
      "cs add-key --host dev      # a specific host",
      "cs add-key --all           # every known host",
    ],
  },
  {
    id: "agent-stop",
    name: "cs agent stop",
    args: "[--host <name>] [--all]",
    helpArgs: "[--host] [--all]",
    summary: "Stop SSH agent on host(s)",
    details: [
      {
        p: "Kill the persistent SSH agent on one or all machines — useful when you are done for the day and want keys out of memory. The agent runs at `~/.ssh/cs-agent.sock` and is started automatically by `cs attach`.",
      },
      {
        p: "Because the agent is shared, stopping it cuts SSH access for every cs session on that host at once.",
      },
    ],
  },
  {
    id: "update",
    name: "cs update",
    args: "[--force] [--all]",
    helpArgs: "",
    summary: "Update cs to latest version",
    variants: [
      { name: "cs update --all", summary: "Update cs on all known hosts via SSH" },
    ],
    details: [
      {
        p: "Check for a new version on the remote server and, if one is available, download the updated bundle and man page. `--force` re-downloads even when the version matches; `--all` updates all known hosts via SSH after updating locally — every host registered by `cs sync`, even one with no sessions, plus hosts with sessions that have not registered yet. A registered host that has not synced in 30 days is skipped and named. Also installs the periodic sync if it is not set up (unless `noCron` is set in config).",
      },
      {
        p: "The downloaded bundle is verified against its published SHA-256 checksum before it replaces the running binary. A missing, malformed, or mismatched checksum aborts the update and leaves the current binary untouched.",
      },
      {
        p: "On its own, that checksum comes from the same origin as the bundle, so it catches a corrupted download but not a compromised repo. Set `mirrorUrl` in config (or `CS_MIRROR_URL`) to a second, independent host serving the same files: the update then proceeds only if both origins publish the identical checksum, and aborts if the mirror is unreachable, disagrees, or is on the same host as the primary.",
      },
    ],
  },
  {
    id: "version",
    name: "cs version",
    alias: "--version",
    summary: "Show current version",
    details: [{ p: "Print the current version and exit." }],
  },
  {
    id: "help",
    name: "cs --help",
    alias: "-h",
    details: [{ p: "Display the usage summary and exit." }],
  },
];

/**
 * What each command accepts after its command word, keyed by that word ("" is
 * the bare dashboard). `main()` in cs.ts parses argv against it via parseArgs and rejects anything else.
 * lib.test.ts checks every flag here against the docs above.
 */
export const ARG_SPECS: Record<string, ArgSpec> = {
  "": { flags: ["--orphans"], optionalValues: ["--sort"], positionals: 0 },
  sync: { flags: ["--quiet"], positionals: 0 },
  list: {
    flags: ["--local"],
    values: ["--host", "--project", "--limit"],
    optionalValues: ["--sort"],
    positionals: 0,
  },
  launch: { positionals: "rest" },
  adopt: { flags: ["--attach"], positionals: 1 },
  attach: { flags: ["--latest"], values: ["--host"], positionals: 1 },
  kill: { flags: ["--all"], values: ["--host"], positionals: 1 },
  resume: { positionals: 0 },
  last: { positionals: 0 },
  status: { positionals: 0 },
  tag: { positionals: 2 },
  info: { positionals: 1 },
  hosts: { positionals: 0 },
  rm: { flags: ["--undo"], positionals: 1 },
  prune: { flags: ["--all"], values: ["--days"], positionals: 0 },
  deleted: { flags: ["--local"], values: ["--host"], positionals: 0 },
  gc: { flags: ["--yes"], positionals: 0 },
  purge: {
    flags: ["--yes", "--all", "--deleted", "--orphans"],
    values: ["--host"],
    positionals: "rest",
  },
  "add-key": { flags: ["--all"], values: ["--host"], positionals: 0 },
  agent: { flags: ["--all"], values: ["--host"], positionals: 1 },
  update: { flags: ["--all", "--force"], positionals: 0 },
  version: { positionals: 0 },
};
