#!/usr/bin/env bun
// cs — Claude Session Manager

import { MongoClient, type Db, type Collection } from "mongodb";
import { readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import { hostname, homedir } from "os";
import {
  type SessionRecord,
  type SessionState,
  type CsConfig,
  SCHEMA_VERSION,
  loadConfig,
  ConfigError,
  redactUri,
  parseSessionJsonl,
  readSummary,
  findValidProjectPath,
  detectState,
  matchPrefix,
  shortId,
  tmuxName,
  relativeTime,
  formatTable,
  bold,
  dim,
  red,
  green,
  cyan,
  machineColor,
  stateColor,
  staleText,
} from "./lib";

// --- db ---

async function withDb<T>(
  config: CsConfig,
  fn: (db: Db, sessions: Collection<SessionRecord>) => Promise<T>
): Promise<T> {
  const client = new MongoClient(config.mongoUri);
  try {
    await client.connect();
    const db = client.db();
    const sessions = db.collection<SessionRecord>("sessions");
    return await fn(db, sessions);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "MongoServerError" ||
        err.name === "MongoNetworkTimeoutError" ||
        err.name === "MongoNetworkError")
    ) {
      console.error(
        `MongoDB error: ${err.message}\nURI: ${redactUri(config.mongoUri)}`
      );
      process.exit(1);
    }
    throw err;
  } finally {
    await client.close();
  }
}

async function tryWithDb<T>(
  config: CsConfig,
  fn: (db: Db, sessions: Collection<SessionRecord>) => Promise<T>
): Promise<T | null> {
  const client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 3000,
  });
  try {
    await client.connect();
    const db = client.db();
    const sessions = db.collection<SessionRecord>("sessions");
    return await fn(db, sessions);
  } catch {
    return null;
  } finally {
    await client.close();
  }
}

// --- tmux helpers ---

async function tmuxRun(
  ...args: string[]
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), exitCode };
  } catch {
    return { stdout: "", exitCode: 1 };
  }
}

async function tmuxListSessions(): Promise<
  Map<string, { name: string; attached: boolean }>
> {
  const result = await tmuxRun(
    "list-sessions",
    "-F",
    "#{session_name}:#{session_attached}"
  );
  const sessions = new Map<string, { name: string; attached: boolean }>();
  if (result.exitCode !== 0) return sessions;

  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name, attached] = line.split(":");
    if (name?.startsWith("cs-")) {
      sessions.set(name, { name, attached: attached === "1" });
    }
  }
  return sessions;
}

async function tmuxCapture(sessionName: string): Promise<string | null> {
  const result = await tmuxRun(
    "capture-pane",
    "-t",
    sessionName,
    "-p"
  );
  return result.exitCode === 0 ? result.stdout : null;
}

async function detectLiveState(
  sessionName: string
): Promise<SessionState | null> {
  const content = await tmuxCapture(sessionName);
  if (content === null) return "DEAD";
  return detectState(content);
}

function requireTmux(): void {
  try {
    const result = Bun.spawnSync(["tmux", "-V"]);
    if (result.exitCode !== 0) throw new Error();
  } catch {
    console.error(
      "tmux is not installed.\nInstall it with: sudo apt install tmux"
    );
    process.exit(1);
  }
}

// --- ensure indexes ---

async function ensureIndexes(
  sessions: Collection<SessionRecord>
): Promise<void> {
  await sessions.createIndex(
    { session_id: 1, machine: 1 },
    { unique: true, background: true }
  );
  await sessions.createIndex(
    { machine: 1, updated_at: -1 },
    { background: true }
  );
  await sessions.createIndex({ project_name: 1 }, { background: true });
}

// --- sync ---

async function cmdSync(
  config: CsConfig,
  quiet: boolean
): Promise<void> {
  const claudeDir = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeDir)) {
    if (!quiet) console.log("~/.claude/projects/ not found — nothing to sync.");
    return;
  }

  const machine = hostname();
  const tmuxSessions = await tmuxListSessions();

  // Collect all session records
  const records: Omit<SessionRecord, "_id">[] = [];
  const projectDirs = readdirSync(claudeDir);

  for (const dirName of projectDirs) {
    const dirPath = join(claudeDir, dirName);
    let stat;
    try {
      stat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const projectPath = findValidProjectPath(dirName);
    if (!projectPath) {
      if (!quiet)
        console.warn(`  skip: cannot decode path for ${dirName}`);
      continue;
    }

    const projectName = basename(projectPath);

    // Find JSONL files
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      const filePath = join(dirPath, file);

      try {
        const fileStat = statSync(filePath);
        const parsed = await parseSessionJsonl(filePath);

        if (parsed.messageCount === 0) continue;

        const tmuxSessionName = tmuxName(sessionId, parsed.sessionName, projectName);
        // Also check legacy cs-<shortid> naming
        const tmuxInfo = tmuxSessions.get(tmuxSessionName)
          ?? tmuxSessions.get(`cs-${sessionId.slice(0, 8)}`);
        let state: SessionState | null = null;

        if (tmuxInfo) {
          state = await detectLiveState(tmuxSessionName);
        }

        const summary = await readSummary(dirPath, sessionId);

        records.push({
          _v: SCHEMA_VERSION,
          session_id: sessionId,
          machine,
          project_path: projectPath,
          project_name: projectName,
          started_at: parsed.startedAt ?? fileStat.birthtime,
          updated_at: fileStat.mtime,
          message_count: parsed.messageCount,
          title: parsed.sessionName ?? parsed.title,
          tag: null,
          state,
          tmux_session: tmuxInfo ? tmuxSessionName : null,
          summary,
          synced_at: new Date(),
        });
      } catch (err) {
        if (!quiet)
          console.warn(`  warn: failed to parse ${file}: ${err}`);
      }
    }
  }

  if (records.length === 0) {
    if (!quiet) console.log("No sessions found to sync.");
    return;
  }

  await withDb(config, async (_db, sessions) => {
    await ensureIndexes(sessions);

    const ops = records.map((rec) => {
      const { tag: _tag, ...rest } = rec;
      return {
        updateOne: {
          filter: { session_id: rec.session_id, machine: rec.machine },
          update: {
            $set: rest,
            $setOnInsert: { tag: null as string | null },
          },
          upsert: true,
        },
      };
    });

    const result = await sessions.bulkWrite(ops);

    if (!quiet) {
      const total = records.length;
      const upserted = result.upsertedCount;
      const modified = result.modifiedCount;
      console.log(
        `Synced ${total} sessions (${upserted} new, ${modified} updated)`
      );
    }
  });
}

// --- commands ---

async function cmdDashboard(config: CsConfig): Promise<void> {
  const machine = hostname();
  requireTmux();

  // Get live tmux sessions
  const tmuxSessions = await tmuxListSessions();
  const liveStates = new Map<string, SessionState | null>();

  for (const [name] of tmuxSessions) {
    liveStates.set(name, await detectLiveState(name));
  }

  // Try MongoDB for recent sessions
  const dbSessions = await tryWithDb(config, async (_db, sessions) => {
    return sessions
      .find({ machine })
      .sort({ updated_at: -1 })
      .limit(10)
      .toArray();
  });

  console.log(bold("  Claude Session Manager\n"));

  // Active tmux sessions
  if (tmuxSessions.size > 0) {
    console.log(bold("Active Sessions:"));
    for (const [name, info] of tmuxSessions) {
      const state = liveStates.get(name);
      const attached = info.attached ? cyan(" (attached)") : "";
      console.log(`  ${name}  ${stateColor(state ?? null)}${attached}`);
    }
    console.log();
  }

  // Recent sessions from DB
  if (dbSessions && dbSessions.length > 0) {
    console.log(bold("Recent Sessions:"));
    const headers = ["PROJECT", "TITLE", "STATE", "UPDATED", "ID"];
    const colWidths = [15, 30, 8, 10, 8];
    const rows = dbSessions.map((s) => [
      staleText(s.project_name, s.updated_at),
      staleText(s.title ?? dim("(no title)"), s.updated_at),
      s.tmux_session && liveStates.has(s.tmux_session)
        ? stateColor(liveStates.get(s.tmux_session) ?? null)
        : stateColor(s.state ?? null),
      relativeTime(s.updated_at),
      dim(shortId(s.session_id)),
    ]);
    console.log(formatTable(headers, rows, colWidths));
  } else if (!dbSessions) {
    console.log(dim("  MongoDB unreachable — showing local tmux sessions only"));
  } else {
    console.log(dim("  No sessions found. Run 'cs sync' to import."));
  }
}

async function cmdList(
  config: CsConfig,
  opts: {
    all: boolean;
    machine: string | null;
    project: string | null;
    limit: number;
  }
): Promise<void> {
  await withDb(config, async (_db, sessions) => {
    const filter: Record<string, unknown> = {};
    if (!opts.all) {
      filter["machine"] = opts.machine ?? hostname();
    }
    if (opts.project) {
      filter["project_name"] = opts.project;
    }

    const results = await sessions
      .find(filter)
      .sort({ updated_at: -1 })
      .limit(opts.limit)
      .toArray();

    if (results.length === 0) {
      console.log("No sessions found.");
      return;
    }

    const headers = ["MACHINE", "PROJECT", "TITLE", "TAG", "STATE", "UPDATED", "ID"];
    const colWidths = [14, 14, 28, 10, 8, 10, 8];
    const rows = results.map((s) => [
      machineColor(s.machine),
      staleText(s.project_name, s.updated_at),
      staleText(s.title ?? dim("(no title)"), s.updated_at),
      s.tag ?? dim("—"),
      stateColor(s.state),
      relativeTime(s.updated_at),
      dim(shortId(s.session_id)),
    ]);

    console.log(formatTable(headers, rows, colWidths));
  });
}

async function cmdLaunch(
  _config: CsConfig,
  project: string,
  prompt: string | null
): Promise<void> {
  requireTmux();

  const claudeArgs = ["claude"];
  if (prompt) {
    claudeArgs.push("-p", prompt);
  }

  // Resolve project directory
  const abs = project.startsWith("/") ? project : join(process.cwd(), project);
  const targetDir = existsSync(abs) ? abs : process.cwd();

  // tmux session name based on project
  const tmuxSession = `cs-${basename(targetDir).slice(0, 20)}-${Date.now().toString(36)}`;

  const result = await tmuxRun(
    "new-session",
    "-d",
    "-s",
    tmuxSession,
    "-c",
    targetDir,
    ...claudeArgs
  );

  if (result.exitCode !== 0) {
    console.error(`Failed to create tmux session: ${result.stdout}`);
    process.exit(1);
  }

  console.log(
    `Launched ${green(tmuxSession)} in ${targetDir}\n` +
      `Attach with: ${bold(`tmux attach -t ${tmuxSession}`)}\n` +
      `Run ${bold("cs sync")} to register in MongoDB, then use ${bold("cs attach")}`
  );
}

async function resolveSession(
  config: CsConfig,
  prefix: string
): Promise<SessionRecord> {
  return withDb(config, async (_db, sessions) => {
    // Try by session ID prefix first
    const byId = await sessions
      .find({ session_id: { $regex: `^${escapeRegex(prefix)}` } })
      .toArray();

    let matches = matchPrefix(byId, prefix);

    // If no ID match, try by title (from /rename)
    if (matches.length === 0) {
      matches = await sessions
        .find({ title: prefix })
        .toArray();
    }

    // Still nothing? Try title as substring (case-insensitive)
    if (matches.length === 0) {
      matches = await sessions
        .find({ title: { $regex: escapeRegex(prefix), $options: "i" } })
        .toArray();
    }

    if (matches.length === 0) {
      console.error(`No session found matching '${prefix}'`);
      process.exit(1);
    }

    if (matches.length > 1) {
      console.error(`Ambiguous match for '${prefix}'. Did you mean:`);
      for (const m of matches) {
        console.error(
          `  ${shortId(m.session_id)}  ${m.project_name}  ${m.machine}  ${m.title ?? ""}`
        );
      }
      process.exit(1);
    }

    return matches[0]!;
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getDetachHint(): Promise<string> {
  const result = await tmuxRun("show-options", "-gv", "prefix");
  const prefix = result.exitCode === 0 && result.stdout ? result.stdout.trim() : "C-b";
  const keyMap: Record<string, string> = {
    "C-b": "Ctrl-b d",
    "C-a": "Ctrl-a d",
    "C-^": "Ctrl-6 d",
    "C-s": "Ctrl-s d",
    "C-q": "Ctrl-q d",
  };
  return keyMap[prefix] ?? `${prefix} d`;
}

async function configureTmuxBar(
  config: CsConfig,
  tmuxSession: string
): Promise<void> {
  // Suppress window name — put everything in status-left
  await tmuxRun("set-option", "-t", tmuxSession, "window-status-format", "");
  await tmuxRun("set-option", "-t", tmuxSession, "window-status-current-format", "");
  await tmuxRun("set-option", "-t", tmuxSession, "status-right", "");

  let statusLeft = `[${tmuxSession}]`;
  if (config.showDetachHint) {
    const hint = await getDetachHint();
    statusLeft += ` detach: ${hint}`;
  }

  await tmuxRun("set-option", "-t", tmuxSession, "status-left-length", "80");
  await tmuxRun("set-option", "-t", tmuxSession, "status-left", ` ${statusLeft}`);
}

async function cmdAttach(
  config: CsConfig,
  prefix: string
): Promise<void> {
  requireTmux();
  const session = await resolveSession(config, prefix);
  const tmuxSession = session.tmux_session ?? tmuxName(session.session_id, session.title, session.project_name);
  const machine = hostname();

  const insideTmux = !!process.env["TMUX"];

  await configureTmuxBar(config, tmuxSession);

  if (session.machine === machine) {
    const tmuxCmd = insideTmux
      ? ["tmux", "switch-client", "-t", tmuxSession]
      : ["tmux", "attach-session", "-t", tmuxSession];
    const proc = Bun.spawn(tmuxCmd, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  } else {
    // Remote attach via SSH
    console.log(`Connecting to ${machineColor(session.machine)}...`);
    // Remote: SSH always gets a fresh terminal, so attach is correct
    const proc = Bun.spawn(
      ["ssh", session.machine, "-t", "tmux", "attach-session", "-t", tmuxSession],
      {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }
    );
    await proc.exited;
  }
}

async function cmdKill(
  config: CsConfig,
  prefix: string
): Promise<void> {
  requireTmux();
  const session = await resolveSession(config, prefix);
  const tmuxSession = session.tmux_session ?? tmuxName(session.session_id, session.title, session.project_name);

  const result = await tmuxRun("kill-session", "-t", tmuxSession);
  if (result.exitCode !== 0) {
    console.error(`Failed to kill session ${tmuxSession}: ${result.stdout}`);
    process.exit(1);
  }

  console.log(`Killed session ${red(tmuxSession)}`);
}

async function cmdResume(config: CsConfig): Promise<void> {
  // Check fzf
  const fzfCheck = Bun.spawnSync(["which", "fzf"]);
  if (fzfCheck.exitCode !== 0) {
    console.error(
      "fzf is not installed.\nInstall it with: sudo apt install fzf"
    );
    process.exit(1);
  }

  const machine = hostname();

  await withDb(config, async (_db, sessions) => {
    const results = await sessions
      .find({ machine })
      .sort({ updated_at: -1 })
      .limit(50)
      .toArray();

    if (results.length === 0) {
      console.log("No sessions found. Run 'cs sync' first.");
      return;
    }

    // Format for fzf
    const lines = results.map(
      (s) =>
        `${shortId(s.session_id)}  ${s.project_name.padEnd(20)}  ${(s.title ?? "(no title)").slice(0, 40).padEnd(40)}  ${relativeTime(s.updated_at)}`
    );

    const fzf = Bun.spawn(["fzf", "--header=Select session to resume"], {
      stdin: new Response(lines.join("\n")),
      stdout: "pipe",
      stderr: "inherit",
    });

    const output = await new Response(fzf.stdout).text();
    const exitCode = await fzf.exited;

    if (exitCode !== 0 || !output.trim()) return; // User cancelled

    const selectedId = output.trim().split(/\s+/)[0]!;
    const match = results.find((s) => s.session_id.startsWith(selectedId));

    if (!match) {
      console.error("Could not find selected session.");
      process.exit(1);
    }

    // Exec into claude --resume
    const proc = Bun.spawn(["claude", "--resume", match.session_id], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  });
}

async function cmdLast(config: CsConfig): Promise<void> {
  const machine = hostname();

  await withDb(config, async (_db, sessions) => {
    const latest = await sessions
      .find({ machine })
      .sort({ updated_at: -1 })
      .limit(1)
      .toArray();

    if (latest.length === 0) {
      console.log("No sessions found. Run 'cs sync' first.");
      return;
    }

    const session = latest[0]!;
    console.log(
      `Resuming: ${session.project_name} — ${session.title ?? "(no title)"}`
    );

    const proc = Bun.spawn(["claude", "--resume", session.session_id], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  });
}

async function cmdStatus(): Promise<void> {
  requireTmux();

  const tmuxSessions = await tmuxListSessions();

  if (tmuxSessions.size === 0) {
    console.log("No active cs sessions.");
    return;
  }

  console.log(bold("Active Sessions:\n"));

  const headers = ["SESSION", "STATE", "ATTACHED"];
  const colWidths = [15, 10, 10];
  const rows: string[][] = [];

  for (const [name, info] of tmuxSessions) {
    const state = await detectLiveState(name);
    rows.push([
      name,
      stateColor(state),
      info.attached ? cyan("yes") : dim("no"),
    ]);
  }

  console.log(formatTable(headers, rows, colWidths));
}

async function cmdTag(
  config: CsConfig,
  prefix: string,
  label: string
): Promise<void> {
  await withDb(config, async (_db, sessions) => {
    const all = await sessions
      .find({ session_id: { $regex: `^${escapeRegex(prefix)}` } })
      .toArray();

    const matches = matchPrefix(all, prefix);

    if (matches.length === 0) {
      console.error(`No session found matching prefix '${prefix}'`);
      process.exit(1);
    }

    if (matches.length > 1) {
      console.error(`Ambiguous prefix '${prefix}'. Did you mean:`);
      for (const m of matches) {
        console.error(`  ${shortId(m.session_id)}  ${m.project_name}  ${m.machine}`);
      }
      process.exit(1);
    }

    const session = matches[0]!;
    await sessions.updateOne(
      { session_id: session.session_id, machine: session.machine },
      { $set: { tag: label } }
    );

    console.log(
      `Tagged ${shortId(session.session_id)} as ${green(label)}`
    );
  });
}

async function cmdInfo(
  config: CsConfig,
  prefix: string
): Promise<void> {
  const session = await resolveSession(config, prefix);

  console.log(bold("Session Info\n"));
  console.log(`  ID:        ${session.session_id}`);
  console.log(`  Machine:   ${machineColor(session.machine)}`);
  console.log(`  Project:   ${session.project_path}`);
  console.log(`  Title:     ${session.title ?? dim("(no title)")}`);
  console.log(`  Tag:       ${session.tag ?? dim("(none)")}`);
  console.log(`  State:     ${stateColor(session.state)}`);
  console.log(`  Messages:  ${session.message_count}`);
  console.log(`  Started:   ${session.started_at.toISOString()}`);
  console.log(`  Updated:   ${session.updated_at.toISOString()} (${relativeTime(session.updated_at)})`);
  console.log(`  tmux:      ${session.tmux_session ?? dim("(none)")}`);
  console.log(`  Schema:    v${session._v ?? 0}`);
  if (session.summary) {
    console.log(`  Summary:   ${session.summary}`);
  }
  console.log(`  Synced:    ${session.synced_at.toISOString()}`);
}

async function cmdMachines(config: CsConfig): Promise<void> {
  await withDb(config, async (_db, sessions) => {
    const pipeline = [
      {
        $group: {
          _id: "$machine",
          count: { $sum: 1 },
          last_seen: { $max: "$updated_at" },
        },
      },
      { $sort: { last_seen: -1 as const } },
    ];

    const results = await sessions.aggregate(pipeline).toArray();

    if (results.length === 0) {
      console.log("No machines found. Run 'cs sync' first.");
      return;
    }

    const headers = ["MACHINE", "SESSIONS", "LAST SEEN"];
    const colWidths = [25, 10, 12];
    const rows = results.map((r) => [
      machineColor(r["_id"] as string),
      String(r["count"]),
      relativeTime(new Date(r["last_seen"] as string)),
    ]);

    console.log(formatTable(headers, rows, colWidths));
  });
}

async function cmdAdopt(
  config: CsConfig,
  prefix: string,
  attach: boolean
): Promise<void> {
  requireTmux();
  const session = await resolveSession(config, prefix);
  const machine = hostname();

  if (session.machine !== machine) {
    console.error(
      `Session ${shortId(session.session_id)} is on ${session.machine}, not this machine.\n` +
        `You can only adopt local sessions.`
    );
    process.exit(1);
  }

  // Check if already in a tmux session
  if (session.tmux_session) {
    const existing = await tmuxRun("has-session", "-t", session.tmux_session);
    if (existing.exitCode === 0) {
      console.log(
        `Session ${shortId(session.session_id)} is already managed as ${green(session.tmux_session)}`
      );
      if (attach) {
        const proc = Bun.spawn(
          ["tmux", "attach-session", "-t", session.tmux_session],
          { stdin: "inherit", stdout: "inherit", stderr: "inherit" }
        );
        await proc.exited;
      }
      return;
    }
  }

  const tmuxSession = tmuxName(session.session_id, session.title, session.project_name);

  const result = await tmuxRun(
    "new-session",
    "-d",
    "-s",
    tmuxSession,
    "-c",
    session.project_path,
    "claude",
    "--resume",
    session.session_id
  );

  if (result.exitCode !== 0) {
    console.error(`Failed to create tmux session: ${result.stdout}`);
    process.exit(1);
  }

  // Update MongoDB with tmux session name
  await withDb(config, async (_db, sessions) => {
    await sessions.updateOne(
      { session_id: session.session_id, machine: session.machine },
      { $set: { tmux_session: tmuxSession, state: "IDLE" as SessionState } }
    );
  });

  console.log(
    `Adopted ${bold(session.title ?? shortId(session.session_id))} as ${green(tmuxSession)}\n` +
      `Claude is resuming in a detached tmux session.`
  );

  if (attach) {
    await configureTmuxBar(config, tmuxSession);
    console.log(`Attaching...\n`);
    const insideTmux = !!process.env["TMUX"];
    const tmuxCmd = insideTmux
      ? ["tmux", "switch-client", "-t", tmuxSession]
      : ["tmux", "attach-session", "-t", tmuxSession];
    const proc = Bun.spawn(tmuxCmd, {
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    await proc.exited;
  } else {
    console.log(`Attach with: ${bold(`cs attach ${shortId(session.session_id)}`)}`);
  }
}

// --- usage ---

function printUsage(): void {
  console.log(`${bold("cs")} — Claude Session Manager

${bold("Usage:")}
  cs                              Smart dashboard
  cs sync [--quiet]               Sync sessions to MongoDB
  cs list [options]               List sessions
  cs launch <project> [prompt]    Launch Claude in detached tmux
  cs adopt <id-prefix> [--attach] Wrap existing session in managed tmux
  cs attach <id-prefix>           Attach to session (local or remote)
  cs kill <id-prefix>             Kill a tmux session
  cs resume                       Interactive session picker (fzf)
  cs last                         Resume most recent session
  cs status                       Live tmux session states
  cs tag <id-prefix> <label>      Tag a session
  cs info <id-prefix>             Show session details
  cs machines                     List machines with session counts

${bold("List options:")}
  --all                           Show all machines
  --machine <hostname>            Filter by machine
  --project <name>                Filter by project
  --limit <n>                     Max results (default: 20)`);
}

// --- main ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // Commands that don't need config/db
  if (command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "status") {
    await cmdStatus();
    return;
  }

  // Load config for everything else
  let config: CsConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // Dashboard (bare cs)
  if (!command) {
    await cmdDashboard(config);
    return;
  }

  switch (command) {
    case "sync": {
      const quiet = args.includes("--quiet");
      await cmdSync(config, quiet);
      break;
    }

    case "list": {
      const all = args.includes("--all");
      const machineIdx = args.indexOf("--machine");
      const machine =
        machineIdx >= 0 ? (args[machineIdx + 1] ?? null) : null;
      const projectIdx = args.indexOf("--project");
      const project =
        projectIdx >= 0 ? (args[projectIdx + 1] ?? null) : null;
      const limitIdx = args.indexOf("--limit");
      const limit =
        limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "20", 10) : 20;
      await cmdList(config, { all, machine, project, limit });
      break;
    }

    case "launch": {
      const project = args[1];
      if (!project) {
        console.error("Usage: cs launch <project> [prompt]");
        process.exit(1);
      }
      const prompt = args.slice(2).join(" ") || null;
      await cmdLaunch(config, project, prompt);
      break;
    }

    case "adopt": {
      const prefix = args[1];
      if (!prefix) {
        console.error("Usage: cs adopt <session_id_prefix> [--attach]");
        process.exit(1);
      }
      const doAttach = args.includes("--attach");
      await cmdAdopt(config, prefix, doAttach);
      break;
    }

    case "attach": {
      const prefix = args[1];
      if (!prefix) {
        console.error("Usage: cs attach <session_id_prefix>");
        process.exit(1);
      }
      await cmdAttach(config, prefix);
      break;
    }

    case "kill": {
      const prefix = args[1];
      if (!prefix) {
        console.error("Usage: cs kill <session_id_prefix>");
        process.exit(1);
      }
      await cmdKill(config, prefix);
      break;
    }

    case "resume":
      await cmdResume(config);
      break;

    case "last":
      await cmdLast(config);
      break;

    case "tag": {
      const prefix = args[1];
      const label = args[2];
      if (!prefix || !label) {
        console.error("Usage: cs tag <session_id_prefix> <label>");
        process.exit(1);
      }
      await cmdTag(config, prefix, label);
      break;
    }

    case "info": {
      const prefix = args[1];
      if (!prefix) {
        console.error("Usage: cs info <session_id_prefix>");
        process.exit(1);
      }
      await cmdInfo(config, prefix);
      break;
    }

    case "machines":
      await cmdMachines(config);
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
