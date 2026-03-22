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
  VERSION,
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
  yellow,
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
    if (name) {
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
          deleted_at: null,
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

    // Get deleted session IDs so we skip them
    const deleted = await sessions
      .find({ machine: records[0]?.machine, deleted_at: { $ne: null } })
      .project({ session_id: 1 })
      .toArray();
    const deletedIds = new Set(deleted.map((d) => d.session_id as string));

    const ops = records
      .filter((rec) => !deletedIds.has(rec.session_id))
      .map((rec) => {
        const { tag: _tag, deleted_at: _del, ...rest } = rec;
        return {
          updateOne: {
            filter: { session_id: rec.session_id, machine: rec.machine },
            update: {
              $set: rest,
              $setOnInsert: { tag: null as string | null, deleted_at: null as Date | null },
            },
            upsert: true,
          },
        };
      });

    if (ops.length === 0) {
      if (!quiet) console.log("No new sessions to sync (all deleted or filtered).");
      return;
    }

    const result = await sessions.bulkWrite(ops);

    if (!quiet) {
      const total = ops.length;
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

  // Get live tmux sessions and their states
  const tmuxSessions = await tmuxListSessions();
  const liveStates = new Map<string, SessionState | null>();
  for (const [name] of tmuxSessions) {
    liveStates.set(name, await detectLiveState(name));
  }

  // Try MongoDB for this machine's sessions
  const dbSessions = await tryWithDb(config, async (_db, sessions) => {
    return sessions
      .find({ machine, deleted_at: null })
      .sort({ updated_at: -1 })
      .limit(15)
      .toArray();
  });

  console.log(bold("  Claude Session Manager\n"));

  const headers = ["PROJECT", "ID", "STATE", "UPDATED", "TITLE"];
  const colWidths = [12, 14, 8, 10, 30];

  if (dbSessions) {
    // Merge: use DB records but overlay live tmux state
    // Track which tmux sessions are accounted for
    const seenTmux = new Set<string>();

    const rows = dbSessions.map((s) => {
      let state: SessionState | null = s.state ?? null;
      if (s.tmux_session && liveStates.has(s.tmux_session)) {
        state = liveStates.get(s.tmux_session) ?? null;
        seenTmux.add(s.tmux_session);
      } else if (s.title && liveStates.has(s.title)) {
        state = liveStates.get(s.title) ?? null;
        seenTmux.add(s.title);
      }
      const proj = s.project_name.length > 12 ? s.project_name.slice(0, 11) + ">" : s.project_name;
      const title = s.title ?? "(no title)";
      const truncTitle = title.length > 30 ? title.slice(0, 29) + ">" : title;
      return [
        staleText(proj, s.updated_at),
        dim(s.session_id.slice(0, 14)),
        stateColor(state),
        relativeTime(s.updated_at),
        staleText(truncTitle, s.updated_at),
      ];
    });

    // Add any tmux sessions not in DB (e.g., launched outside cs)
    for (const [name] of tmuxSessions) {
      if (!seenTmux.has(name)) {
        rows.unshift([
          dim("—"),
          dim("—"),
          stateColor(liveStates.get(name) ?? null),
          dim("live"),
          name,
        ]);
      }
    }

    if (rows.length > 0) {
      console.log(formatTable(headers, rows, colWidths));
    } else {
      console.log(dim("  No sessions found. Run 'cs sync' to import."));
    }
  } else {
    // DB unreachable — show tmux sessions only
    console.log(dim("  MongoDB unreachable — showing local tmux only\n"));
    if (tmuxSessions.size > 0) {
      const rows = [...tmuxSessions.entries()].map(([name, info]) => [
        dim("—"),
        dim("—"),
        stateColor(liveStates.get(name) ?? null),
        info.attached ? cyan("attached") : dim("detached"),
        name,
      ]);
      console.log(formatTable(headers, rows, colWidths));
    } else {
      console.log(dim("  No active sessions."));
    }
  }
}

async function cmdList(
  config: CsConfig,
  opts: {
    local: boolean;
    host: string | null;
    project: string | null;
    limit: number;
  }
): Promise<void> {
  await withDb(config, async (_db, sessions) => {
    const filter: Record<string, unknown> = {};
    if (opts.local) {
      filter["machine"] = hostname();
    } else if (opts.host) {
      // Match full hostname or short name
      filter["machine"] = opts.host.includes(".")
        ? { $regex: `^${escapeRegex(opts.host)}$`, $options: "i" }
        : { $regex: `^${escapeRegex(opts.host)}(\\.|\$)`, $options: "i" };
    }
    if (opts.project) {
      filter["project_name"] = opts.project;
    }

    const results = await sessions
      .find({ ...filter, deleted_at: null })
      .sort({ updated_at: -1 })
      .limit(opts.limit)
      .toArray();

    if (results.length === 0) {
      console.log("No sessions found.");
      return;
    }

    const headers = ["PROJECT", "ID", "HOST", "STATE", "UPDATED", "TITLE"];
    const colWidths = [12, 14, 8, 8, 10, 30];
    const rows = results.map((s) => {
      const proj = s.project_name.length > 12 ? s.project_name.slice(0, 11) + ">" : s.project_name;
      const title = s.title ?? "(no title)";
      const truncTitle = title.length > 30 ? title.slice(0, 29) + ">" : title;
      return [
        staleText(proj, s.updated_at),
        dim(s.session_id.slice(0, 14)),
        machineColor(config.listFQDN ? s.machine : s.machine.split(".")[0]!),
        stateColor(s.state),
        relativeTime(s.updated_at),
        staleText(truncTitle, s.updated_at),
      ];
    });

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
    "bash", "-lc", claudeArgs.join(" ")
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
  prefix: string,
  host?: string | null
): Promise<SessionRecord> {
  return withDb(config, async (_db, sessions) => {
    // Build host filter
    const hostFilter: Record<string, unknown> = {};
    if (host) {
      hostFilter["machine"] = host.includes(".")
        ? { $regex: `^${escapeRegex(host)}$`, $options: "i" }
        : { $regex: `^${escapeRegex(host)}(\\.|\$)`, $options: "i" };
    }

    const base = { ...hostFilter, deleted_at: null };

    // Try by session ID prefix first
    const byId = await sessions
      .find({ ...base, session_id: { $regex: `^${escapeRegex(prefix)}` } })
      .toArray();

    let matches = matchPrefix(byId, prefix);

    // Try exact title match (from /rename)
    if (matches.length === 0) {
      matches = await sessions
        .find({ ...base, title: prefix })
        .toArray();
    }

    // Try exact project name match
    if (matches.length === 0) {
      matches = await sessions
        .find({ ...base, project_name: prefix })
        .toArray();
    }

    // Last resort: title prefix (starts with, not substring)
    if (matches.length === 0) {
      matches = await sessions
        .find({ ...base, title: { $regex: `^${escapeRegex(prefix)}`, $options: "i" } })
        .toArray();
    }

    if (matches.length === 0) {
      console.error(`No session found matching '${prefix}'`);
      process.exit(1);
    }

    if (matches.length > 1) {
      // Prefer local host when ambiguous and no explicit --host
      if (!host) {
        const local = matches.filter((m) => m.machine.toLowerCase() === hostname().toLowerCase());
        if (local.length === 1) return local[0]!;
      }

      console.error(`Ambiguous match for '${prefix}'. Did you mean:`);
      for (const m of matches) {
        console.error(
          `  ${m.project_name}  ${m.session_id}  ${m.machine}  ${m.title ?? ""}`
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


async function configureTmuxBar(
  config: CsConfig,
  tmuxSession: string
): Promise<void> {
  // Suppress window name — put everything in status-left
  await tmuxRun("set-option", "-t", tmuxSession, "window-status-format", "");
  await tmuxRun("set-option", "-t", tmuxSession, "window-status-current-format", "");
  await tmuxRun("set-option", "-t", tmuxSession, "status-right", "");

  const shortHost = hostname().split(".")[0]!;
  let statusLeft = `[${shortHost}:${tmuxSession}]`;
  if (config.showDetachHint) {
    const prefixResult = await tmuxRun("show-options", "-gv", "prefix");
    const prefix = prefixResult.exitCode === 0 && prefixResult.stdout ? prefixResult.stdout.trim() : "C-b";
    const keyMap: Record<string, string> = {
      "C-b": "C-b", "C-a": "C-a", "C-^": "C-6", "C-s": "C-s", "C-q": "C-q",
    };
    const pfx = keyMap[prefix] ?? prefix;

    const hints: string[] = [];
    hints.push(`help: ${pfx} ?`);
    hints.push(`detach: ${pfx} d`);

    const mouseResult = await tmuxRun("show-options", "-gv", "mouse");
    if (mouseResult.exitCode === 0 && mouseResult.stdout.trim() === "on") {
      hints.push(`mouse: shift+click`);
    }

    hints.push(`scroll: ${pfx} [`);

    statusLeft += ` ${hints.join(" | ")}`;
  }

  const r1 = await tmuxRun("set-option", "-t", tmuxSession, "status-left-length", "120");
  const r2 = await tmuxRun("set-option", "-t", tmuxSession, "status-left", ` ${statusLeft}`);
  if (r1.exitCode !== 0 || r2.exitCode !== 0) {
    // Debug: bar config failed — log but don't crash
    process.stderr.write(`tmux bar config failed: r1=${r1.exitCode} r2=${r2.exitCode} session=${tmuxSession}\n`);
  }
}

async function cmdAttach(
  config: CsConfig,
  prefix: string,
  host?: string | null
): Promise<void> {
  requireTmux();
  const session = await resolveSession(config, prefix, host);
  const tmuxSession = session.tmux_session ?? tmuxName(session.session_id, session.title, session.project_name);
  const machine = hostname();

  const insideTmux = !!process.env["TMUX"];

  if (session.machine.toLowerCase() === machine.toLowerCase()) {
    // Check if tmux session exists, adopt if not
    const check = await tmuxRun("has-session", "-t", tmuxSession);
    if (check.exitCode !== 0) {
      console.log(`Session not running — starting ${green(tmuxSession)}...`);
      const create = await tmuxRun(
        "new-session", "-d", "-s", tmuxSession,
        "-c", session.project_path,
        "bash", "-lc", `claude --resume ${session.session_id}`
      );
      if (create.exitCode !== 0) {
        console.error(`Failed to create tmux session: ${create.stdout}`);
        process.exit(1);
      }
      // Ensure tmux.conf is loaded (new server starts with defaults)
      const tmuxConf = join(homedir(), ".tmux.conf");
      if (existsSync(tmuxConf)) {
        await tmuxRun("source-file", tmuxConf);
      }
    }

    await configureTmuxBar(config, tmuxSession);

    // Forward SSH agent into tmux so git/ssh work inside sessions
    // Use the fixed symlink path — new shells spawned by Claude will pick it up
    const authSockSymlink = join(homedir(), ".ssh", "auth_sock");
    const authSock = process.env["SSH_AUTH_SOCK"];
    if (authSock && authSock !== authSockSymlink) {
      // Refresh the symlink to point to the current live socket
      try {
        const { symlinkSync, unlinkSync } = await import("fs");
        try { unlinkSync(authSockSymlink); } catch { /* may not exist */ }
        symlinkSync(authSock, authSockSymlink);
      } catch { /* best effort */ }
    }
    // Set tmux environment to the fixed symlink path (survives reconnects)
    if (existsSync(authSockSymlink)) {
      await tmuxRun("set-environment", "-g", "SSH_AUTH_SOCK", authSockSymlink);
    }

    // Update MongoDB with tmux session name and state
    await withDb(config, async (_db, sessions) => {
      await sessions.updateOne(
        { session_id: session.session_id, machine: session.machine },
        { $set: { tmux_session: tmuxSession, state: "IDLE" as SessionState } }
      );
    });

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
    // Remote: ensure session exists, then attach in a clean SSH
    console.log(`Connecting to ${machineColor(session.machine)}...`);

    // Write a helper script on the remote to avoid quoting hell
    // It creates the session if needed, sources .tmux.conf, and configures the bar
    const script = [
      `#!/bin/bash`,
      `source ~/.bash_profile 2>/dev/null || source ~/.bashrc 2>/dev/null`,
      `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`,
      `if ! tmux has-session -t '${tmuxSession}' 2>/dev/null; then`,
      `  cd '${session.project_path}' 2>/dev/null`,
      `  tmux new-session -d -s '${tmuxSession}' claude --resume '${session.session_id}'`,
      `  [ -f ~/.tmux.conf ] && tmux source-file ~/.tmux.conf 2>/dev/null`,
      `fi`,
      // Configure bar using remote tmux prefix (not local)
      `PREFIX=$(tmux show-options -gv prefix 2>/dev/null || echo C-b)`,
      `case "$PREFIX" in`,
      `  C-b) PFX="C-b" ;; C-a) PFX="C-a" ;; "C-^") PFX="C-6" ;; *) PFX="$PREFIX" ;;`,
      `esac`,
      `HOST=$(hostname | cut -d. -f1)`,
      `BAR="[$HOST:${tmuxSession}]"`,
      config.showDetachHint ? [
        `BAR="$BAR help: $PFX ? | detach: $PFX d"`,
        `MOUSE=$(tmux show-options -gv mouse 2>/dev/null)`,
        `[ "$MOUSE" = "on" ] && BAR="$BAR | mouse: shift+click"`,
        `BAR="$BAR | scroll: $PFX ["`,
      ].join("\n") : ``,
      `tmux set-option -t '${tmuxSession}' window-status-format '' 2>/dev/null`,
      `tmux set-option -t '${tmuxSession}' window-status-current-format '' 2>/dev/null`,
      `tmux set-option -t '${tmuxSession}' status-right '' 2>/dev/null`,
      `tmux set-option -t '${tmuxSession}' status-left-length 120 2>/dev/null`,
      `tmux set-option -t '${tmuxSession}' status-left " $BAR" 2>/dev/null`,
    ].filter(Boolean).join("\n");

    const ensure = Bun.spawn([
      "ssh", session.machine, "bash", "-s",
    ], {
      stdin: new Response(script),
      stdout: "pipe",
      stderr: "pipe",
    });
    await ensure.exited;

    // Update MongoDB with tmux session name and state
    await withDb(config, async (_db, sessions) => {
      await sessions.updateOne(
        { session_id: session.session_id, machine: session.machine },
        { $set: { tmux_session: tmuxSession, state: "IDLE" as SessionState } }
      );
    });

    // Step 2: attach with a clean TTY
    const proc = Bun.spawn([
      "ssh", session.machine, "-t",
      "tmux", "attach-session", "-t", tmuxSession,
    ], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  }
}

async function killOneSession(
  session: SessionRecord,
  machine: string,
  sessionsCol?: Collection<SessionRecord>
): Promise<boolean> {
  const tmuxSession = session.tmux_session ?? tmuxName(session.session_id, session.title, session.project_name);
  const isLocal = session.machine.toLowerCase() === machine.toLowerCase();
  let ok: boolean;

  if (isLocal) {
    const result = await tmuxRun("kill-session", "-t", tmuxSession);
    ok = result.exitCode === 0;
  } else {
    const candidates = [session.machine, session.machine.toLowerCase()];
    const short = session.machine.split(".")[0]!;
    if (short !== session.machine) candidates.push(short, short.toLowerCase());
    const tryHosts = [...new Set(candidates)];

    ok = false;
    for (const h of tryHosts) {
      const proc = Bun.spawn([
        "ssh", h, "-o", "ConnectTimeout=5", "-o", "BatchMode=yes",
        "tmux", "kill-session", "-t", tmuxSession,
      ], { stdout: "pipe", stderr: "pipe" });
      if ((await proc.exited) === 0) { ok = true; break; }
    }
  }

  if (ok && sessionsCol) {
    await sessionsCol.updateOne(
      { session_id: session.session_id, machine: session.machine },
      { $set: { state: "DEAD" as SessionState, tmux_session: null } }
    );
  }

  return ok;
}

async function cmdKill(
  config: CsConfig,
  opts: {
    pattern: string | null;
    host: string | null;
    all: boolean;
  }
): Promise<void> {
  const machine = hostname();

  if (opts.all) {
    // Kill all sessions, optionally filtered by host
    await withDb(config, async (_db, sessions) => {
      const filter: Record<string, unknown> = { deleted_at: null };
      if (opts.host) {
        filter["machine"] = opts.host.includes(".")
          ? opts.host
          : { $regex: `^${escapeRegex(opts.host)}(\\.|\$)`, $options: "i" };
      }
      // Only kill sessions that have tmux sessions
      filter["$or"] = [
        { tmux_session: { $ne: null } },
        { state: { $in: ["WORKING", "WAITING", "IDLE"] } },
      ];

      const targets = await sessions.find(filter).toArray();
      if (targets.length === 0) {
        console.log("No active sessions to kill.");
        return;
      }

      console.log(`Killing ${targets.length} session(s)...`);
      for (const s of targets) {
        const name = s.tmux_session ?? tmuxName(s.session_id, s.title, s.project_name);
        const shortHost = s.machine.split(".")[0]!;
        const ok = await killOneSession(s, machine, sessions);
        if (ok) {
          console.log(`  ${red(name)} on ${shortHost}`);
        } else {
          console.log(`  ${dim(name)} on ${shortHost} ${dim("(not running)")}`);
        }
      }
    });
  } else {
    // Kill one session
    if (!opts.pattern) {
      console.error("Usage: cs kill <id-or-name> [--host <name>]");
      process.exit(1);
    }
    const session = await resolveSession(config, opts.pattern, opts.host);
    const tmuxSession = session.tmux_session ?? tmuxName(session.session_id, session.title, session.project_name);
    const ok = await withDb(config, async (_db, sessions) => {
      return killOneSession(session, machine, sessions);
    });
    if (ok) {
      console.log(`Killed ${red(tmuxSession)}`);
    } else {
      console.error(`Session ${tmuxSession} not running`);
      process.exit(1);
    }
  }
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
      .find({ machine, deleted_at: null })
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
      .find({ machine, deleted_at: null })
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
      .find({ session_id: { $regex: `^${escapeRegex(prefix)}` }, deleted_at: null })
      .toArray();

    const matches = matchPrefix(all, prefix);

    if (matches.length === 0) {
      console.error(`No session found matching prefix '${prefix}'`);
      process.exit(1);
    }

    if (matches.length > 1) {
      console.error(`Ambiguous prefix '${prefix}'. Did you mean:`);
      for (const m of matches) {
        console.error(`  ${m.project_name}  ${m.session_id}  ${m.machine}  ${m.title ?? ""}`);
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
  console.log(`  Host:      ${machineColor(config.listFQDN ? session.machine : session.machine.split(".")[0]!)}`);
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

async function cmdHosts(config: CsConfig): Promise<void> {
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
      console.log("No hosts found. Run 'cs sync' first.");
      return;
    }

    const headers = ["HOST", "SESSIONS", "LAST SEEN"];
    const colWidths = [25, 10, 12];
    const rows = results.map((r) => [
      machineColor(config.listFQDN ? (r["_id"] as string) : (r["_id"] as string).split(".")[0]!),
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
    "bash", "-lc", `claude --resume ${session.session_id}`
  );

  if (result.exitCode !== 0) {
    console.error(`Failed to create tmux session: ${result.stdout}`);
    process.exit(1);
  }

  // Ensure tmux.conf is loaded (new server starts with defaults)
  const tmuxConf = join(homedir(), ".tmux.conf");
  if (existsSync(tmuxConf)) {
    await tmuxRun("source-file", tmuxConf);
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

async function cmdRm(
  config: CsConfig,
  prefix: string,
  undo: boolean
): Promise<void> {
  // For undo, we need to search including deleted records
  await withDb(config, async (_db, sessions) => {
    const filter = undo
      ? { $or: [
          { session_id: { $regex: `^${escapeRegex(prefix)}` } },
          { title: prefix },
          { title: { $regex: escapeRegex(prefix), $options: "i" } },
        ]}
      : { $or: [
          { session_id: { $regex: `^${escapeRegex(prefix)}` }, deleted_at: null },
          { title: prefix, deleted_at: null },
          { title: { $regex: escapeRegex(prefix), $options: "i" }, deleted_at: null },
        ]};

    const all = await sessions.find(filter).toArray();

    // For ID prefix, filter further
    let matches = all.filter((r) => r.session_id.startsWith(prefix));
    if (matches.length === 0) matches = all;

    if (matches.length === 0) {
      console.error(`No session found matching '${prefix}'`);
      process.exit(1);
    }

    if (matches.length > 1) {
      console.error(`Ambiguous match for '${prefix}'. Did you mean:`);
      for (const m of matches) {
        console.error(`  ${m.project_name}  ${m.session_id}  ${m.machine}  ${m.title ?? ""}`);
      }
      process.exit(1);
    }

    const session = matches[0]!;

    if (undo) {
      await sessions.updateOne(
        { session_id: session.session_id, machine: session.machine },
        { $set: { deleted_at: null } }
      );
      console.log(`Restored ${session.title ?? shortId(session.session_id)}`);
    } else {
      await sessions.updateOne(
        { session_id: session.session_id, machine: session.machine },
        { $set: { deleted_at: new Date() } }
      );
      console.log(`Removed ${session.title ?? shortId(session.session_id)} (cs rm --undo ${shortId(session.session_id)} to restore)`);
    }
  });
}

async function cmdPrune(
  config: CsConfig,
  days: number,
  all: boolean
): Promise<void> {
  const machine = hostname();

  await withDb(config, async (_db, sessions) => {
    const filter: Record<string, unknown> = {
      machine,
      deleted_at: null,
      // Keep anything with a /rename name or tag
      $and: [
        { $or: [{ tag: null }, { tag: { $exists: false } }] },
      ],
    };

    if (!all) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      filter["updated_at"] = { $lt: cutoff };
    }

    // Find candidates — exclude sessions whose title looks intentional (set via /rename)
    const candidates = await sessions.find(filter).toArray();

    // Filter out sessions that were /renamed (title != first message pattern)
    // We can't perfectly distinguish, but tagged sessions are already excluded
    // For now, prune anything unnamed+untagged matching the age filter

    if (candidates.length === 0) {
      console.log("Nothing to prune.");
      return;
    }

    const result = await sessions.updateMany(
      { _id: { $in: candidates.map((c) => c._id) } },
      { $set: { deleted_at: new Date() } }
    );

    console.log(`Pruned ${result.modifiedCount} sessions (cs deleted to view, cs rm --undo <id> to restore)`);
  });
}

async function cmdDeleted(
  config: CsConfig,
  opts: { local: boolean; host: string | null }
): Promise<void> {
  await withDb(config, async (_db, sessions) => {
    const filter: Record<string, unknown> = { deleted_at: { $ne: null } };
    if (opts.local) {
      filter["machine"] = hostname();
    } else if (opts.host) {
      filter["machine"] = opts.host.includes(".")
        ? { $regex: `^${escapeRegex(opts.host)}$`, $options: "i" }
        : { $regex: `^${escapeRegex(opts.host)}(\\.|\$)`, $options: "i" };
    }

    const results = await sessions
      .find(filter)
      .sort({ deleted_at: -1 })
      .limit(50)
      .toArray();

    if (results.length === 0) {
      console.log("No deleted sessions.");
      return;
    }

    const headers = ["PROJECT", "ID", "HOST", "DELETED", "TITLE"];
    const colWidths = [12, 14, 8, 10, 30];
    const rows = results.map((s) => {
      const proj = s.project_name.length > 12 ? s.project_name.slice(0, 11) + ">" : s.project_name;
      const title = s.title ?? "(no title)";
      const truncTitle = title.length > 30 ? title.slice(0, 29) + ">" : title;
      return [
        proj,
        dim(s.session_id.slice(0, 14)),
        machineColor(config.listFQDN ? s.machine : s.machine.split(".")[0]!),
        relativeTime(s.deleted_at!),
        truncTitle,
      ];
    });

    console.log(formatTable(headers, rows, colWidths));
  });
}

function purgeOneSession(
  session: SessionRecord,
  claudeDir: string
): { jsonlPath: string; sessionDir: string; deleted: string[] } {
  const pathHash = `-${session.project_path.slice(1).replace(/[/.]/g, "-")}`;
  const jsonlPath = join(claudeDir, pathHash, `${session.session_id}.jsonl`);
  const sessionDir = join(claudeDir, pathHash, session.session_id);
  const deleted: string[] = [];

  const { rmSync } = require("fs") as typeof import("fs");
  if (existsSync(jsonlPath)) {
    rmSync(jsonlPath);
    deleted.push(jsonlPath);
  }
  if (existsSync(sessionDir)) {
    rmSync(sessionDir, { recursive: true });
    deleted.push(sessionDir + "/");
  }

  // Kill tmux if running
  const tmuxSession = tmuxName(session.session_id, session.title, session.project_name);
  Bun.spawnSync(["tmux", "kill-session", "-t", tmuxSession], { stdout: "pipe", stderr: "pipe" });
  if (session.tmux_session) {
    Bun.spawnSync(["tmux", "kill-session", "-t", session.tmux_session], { stdout: "pipe", stderr: "pipe" });
  }

  return { jsonlPath, sessionDir, deleted };
}

async function cmdPurge(
  config: CsConfig,
  pattern: string,
  confirm: boolean,
  all: boolean,
  host: string | null,
  deletedOnly: boolean
): Promise<void> {
  const machine = hostname();
  const claudeDir = join(homedir(), ".claude", "projects");

  await withDb(config, async (_db, sessions) => {
    // Build host filter
    const hostFilter: Record<string, unknown> = {};
    if (host) {
      hostFilter["machine"] = host.includes(".")
        ? { $regex: `^${escapeRegex(host)}$`, $options: "i" }
        : { $regex: `^${escapeRegex(host)}(\\.|\$)`, $options: "i" };
    }

    // Deleted filter
    const delFilter: Record<string, unknown> = deletedOnly
      ? { deleted_at: { $ne: null } }
      : {};

    // Find matching sessions
    let matches: SessionRecord[];

    if (all) {
      // Bulk mode: match pattern against session_id prefix, title, or project name
      const baseFilter = { ...hostFilter, ...delFilter };
      matches = await sessions
        .find({
          ...baseFilter,
          $or: [
            { session_id: { $regex: `^${escapeRegex(pattern)}` } },
            { title: { $regex: escapeRegex(pattern), $options: "i" } },
            { project_name: { $regex: escapeRegex(pattern), $options: "i" } },
          ],
        })
        .toArray();
    } else {
      // Single mode: exact resolve
      const found = await sessions
        .find({ $or: [
          { session_id: { $regex: `^${escapeRegex(pattern)}` } },
          { title: pattern },
          { project_name: pattern },
          { title: { $regex: `^${escapeRegex(pattern)}`, $options: "i" } },
        ]})
        .toArray();

      let filtered = found.filter((r) => r.session_id.startsWith(pattern));
      if (filtered.length === 0) filtered = found;

      if (filtered.length === 0) {
        console.error(`No session found matching '${pattern}'`);
        process.exit(1);
      }
      if (filtered.length > 1) {
        // Prefer local
        const local = filtered.filter((m) => m.machine.toLowerCase() === machine.toLowerCase());
        if (local.length === 1) {
          matches = local;
        } else {
          console.error(`Ambiguous match for '${pattern}'. Did you mean:`);
          for (const m of filtered) {
            console.error(`  ${m.project_name}  ${m.session_id}  ${m.machine}  ${m.title ?? ""}`);
          }
          process.exit(1);
        }
      } else {
        matches = filtered;
      }
    }

    if (matches.length === 0) {
      console.log(`No sessions matching '${pattern}' on this host.`);
      return;
    }

    // Check all are local
    const nonLocal = matches.filter((m) => m.machine.toLowerCase() !== machine.toLowerCase());
    if (nonLocal.length > 0 && confirm) {
      console.error(`Cannot purge ${nonLocal.length} session(s) on other hosts. Run cs purge there.`);
      const localOnly = matches.filter((m) => m.machine.toLowerCase() === machine.toLowerCase());
      if (localOnly.length === 0) process.exit(1);
      matches = localOnly;
    }

    // Show what will be purged
    console.log(`${all ? "Bulk purge" : "Purge"} ${matches.length} session(s) matching '${pattern}':\n`);
    for (const s of matches) {
      const pathHash = `-${s.project_path.slice(1).replace(/[/.]/g, "-")}`;
      const jsonlPath = join(claudeDir, pathHash, `${s.session_id}.jsonl`);
      const local = s.machine.toLowerCase() === machine.toLowerCase();
      console.log(`  ${s.project_name}  ${s.session_id.slice(0, 14)}  ${s.machine}  ${s.title ?? "(no title)"}  ${local && existsSync(jsonlPath) ? "files: yes" : dim("files: no")}`);
    }

    if (!confirm) {
      if (nonLocal.length > 0) {
        console.log(yellow(`\n  ${nonLocal.length} session(s) on other hosts — run cs purge there`));
      }
      console.log(`\nRun with --yes to confirm.`);
      return;
    }

    // Bulk: demand typed confirmation
    if (all && matches.length > 1) {
      process.stdout.write(`\nType YES to permanently delete ${matches.length} sessions: `);
      const buf = Buffer.alloc(10);
      const n = require("fs").readSync(0, buf, 0, 10);
      const answer = buf.slice(0, n).toString().trim();
      if (answer !== "YES") {
        console.log("Aborted.");
        return;
      }
    }

    // Purge
    let purged = 0;
    for (const s of matches.filter((m) => m.machine.toLowerCase() === machine.toLowerCase())) {
      const result = purgeOneSession(s, claudeDir);
      await sessions.deleteOne({ session_id: s.session_id, machine: s.machine });
      for (const f of result.deleted) console.log(`  Deleted ${f}`);
      purged++;
    }

    console.log(`\nPurged ${red(String(purged))} session(s).`);
  });
}

const BASE_URL = process.env["CS_REPO_URL"] ?? "https://git.bogometer.com/shartman/claude-session/-/raw/main";

function ensureCron(): void {
  try {
    let noCron = false;
    try {
      const cfg = loadConfig();
      noCron = cfg.noCron === true;
    } catch { /* config not available */ }

    if (!noCron) {
      const cron = Bun.spawnSync(["bash", "-c", "crontab -l 2>/dev/null"]);
      const cronOut = cron.stdout.toString();
      if (!cronOut.includes("cs sync")) {
        const cronLine = '*/5 * * * * PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" cs sync --quiet 2>/dev/null';
        const script = `existing=$(crontab -l 2>/dev/null)\nprintf '%s\\n%s\\n' "$existing" '${cronLine}' | crontab -`;
        const result = Bun.spawnSync(["bash", "-c", script]);
        if (result.exitCode === 0) {
          console.log(`Added cron: sync every 5 minutes`);
        } else {
          console.log(dim(`Could not add cron entry — add manually: ${cronLine}`));
        }
      }
    }
  } catch {
    // crontab not available — skip
  }
}

async function cmdUpdate(): Promise<void> {
  // Fetch remote version
  let remoteVersion: string;
  try {
    const resp = await fetch(`${BASE_URL}/VERSION`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    remoteVersion = (await resp.text()).trim();
  } catch (err) {
    console.error(`Failed to check for updates: ${err}`);
    process.exit(1);
  }

  if (remoteVersion === VERSION) {
    console.log(`cs v${VERSION} is up to date.`);
    ensureCron();
    return;
  }

  console.log(`Updating cs v${VERSION} → v${remoteVersion}...`);

  // Download new bundle
  const binPath = `${homedir()}/.local/bin/cs`;
  try {
    const resp = await fetch(`${BASE_URL}/cs.bundle.js`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const content = await resp.text();
    await Bun.write(binPath, content);
    const { chmodSync } = await import("fs");
    chmodSync(binPath, 0o755);
  } catch (err) {
    console.error(`Failed to download bundle: ${err}`);
    process.exit(1);
  }

  // Update man page
  const manPath = `${homedir()}/.local/share/man/man1/cs.1`;
  try {
    const resp = await fetch(`${BASE_URL}/cs.1`);
    if (resp.ok) {
      const { mkdirSync } = await import("fs");
      mkdirSync(`${homedir()}/.local/share/man/man1`, { recursive: true });
      await Bun.write(manPath, await resp.text());
    }
  } catch {
    // Man page update is non-critical
  }

  console.log(`Updated to cs v${remoteVersion}`);
  ensureCron();
}

async function cmdUpdateAll(config: CsConfig): Promise<void> {
  // Update locally first
  await cmdUpdate();

  // Get all distinct hosts from MongoDB
  const hosts = await withDb(config, async (_db, sessions) => {
    const pipeline = [
      { $group: { _id: "$machine" } },
    ];
    return sessions.aggregate(pipeline).toArray();
  });

  const localHost = hostname();
  const remoteHosts = hosts
    .map((h) => h["_id"] as string)
    .filter((h) => h.toLowerCase() !== localHost.toLowerCase());

  if (remoteHosts.length === 0) {
    console.log("\nNo remote hosts to update.");
    return;
  }

  console.log(`\nUpdating ${remoteHosts.length} remote host(s)...`);

  for (const host of remoteHosts) {
    const shortName = host.split(".")[0]!;
    process.stdout.write(`  ${shortName}: `);

    // Try original hostname, then lowercase (handles Windows DNS uppercase)
    const candidates = [host, host.toLowerCase()];
    if (shortName !== host) candidates.push(shortName, shortName.toLowerCase());
    // Dedupe
    const tryHosts = [...new Set(candidates)];

    let success = false;
    for (const tryHost of tryHosts) {
      const proc = Bun.spawn([
        "ssh", tryHost, "-o", "ConnectTimeout=5", "-o", "BatchMode=yes",
        "PATH=$HOME/.local/bin:$HOME/.bun/bin:$PATH cs update",
      ], { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        console.log(stdout.trim().split("\n").pop() ?? "done");
        success = true;
        break;
      }
    }
    if (!success) {
      console.log(red("failed"));
    }
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
  cs kill <id-or-name> [--host <name>]  Kill a tmux session (local or remote)
  cs kill --all [--host <name>]   Kill all sessions (optionally on one host)
  cs resume                       Interactive session picker (fzf)
  cs last                         Resume most recent session
  cs status                       Live tmux session states
  cs tag <id-prefix> <label>      Tag a session
  cs info <id-prefix>             Show session details
  cs hosts                        List hosts with session counts
  cs rm <id-or-name>              Soft-delete a session
  cs rm --undo <id-or-name>       Restore a soft-deleted session
  cs prune [--days N] [--all]     Bulk soft-delete unnamed/untagged sessions
  cs deleted                      List soft-deleted sessions
  cs purge <pattern> [--yes]      Hard delete one session + local files (irreversible)
  cs purge <pattern> --all [--yes] [--host <name>] [--deleted]
                                  Bulk hard delete matching sessions
  cs update                       Update cs to latest version
  cs update --all                 Update cs on all known hosts via SSH
  cs version                      Show current version

${bold("List options:")}
  --local                         This host only
  --host <hostname>               Filter by host
  --project <name>                Filter by project
  --limit <n>                     Max results (default: 20)

${bold("Install:")}
  curl -sSL ${BASE_URL.replace("/-/raw/main", "/-/raw/main/install-remote.sh")} | bash
  curl ... | bash -s -- --nocron --noconfig   (skip cron/config)

${bold("Environment:")}
  CS_REPO_URL                     Override repo URL for update/install
  NO_COLOR                        Disable color output`);
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

  if (command === "update") {
    if (args.includes("--all")) {
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
      await cmdUpdateAll(config);
    } else {
      await cmdUpdate();
    }
    return;
  }

  if (command === "version" || command === "--version") {
    console.log(`cs v${VERSION}`);
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
      const local = args.includes("--local");
      const hostIdx = args.indexOf("--host");
      const host =
        hostIdx >= 0 ? (args[hostIdx + 1] ?? null) : null;
      const projectIdx = args.indexOf("--project");
      const project =
        projectIdx >= 0 ? (args[projectIdx + 1] ?? null) : null;
      const limitIdx = args.indexOf("--limit");
      const limit =
        limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "20", 10) : 20;
      await cmdList(config, { local, host, project, limit });
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
      const hostIdx = args.indexOf("--host");
      const host = hostIdx >= 0 ? (args[hostIdx + 1] ?? null) : null;
      const prefix = args.filter((a) => a !== "--host" && a !== host)[1];
      if (!prefix) {
        console.error("Usage: cs attach <id-or-name> [--host <name>]");
        process.exit(1);
      }
      await cmdAttach(config, prefix, host);
      break;
    }

    case "kill": {
      const all = args.includes("--all");
      const hostIdx = args.indexOf("--host");
      const host = hostIdx >= 0 ? (args[hostIdx + 1] ?? null) : null;
      const pattern = args.filter((a) => !a.startsWith("--") && a !== host)[1] ?? null;
      if (!all && !pattern) {
        console.error("Usage: cs kill <id-or-name> [--host <name>] | cs kill --all [--host <name>]");
        process.exit(1);
      }
      await cmdKill(config, { pattern, host, all });
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

    case "hosts":
      await cmdHosts(config);
      break;

    case "rm": {
      const undo = args.includes("--undo");
      const prefix = args.filter((a) => a !== "--undo")[1];
      if (!prefix) {
        console.error("Usage: cs rm <id-or-name> [--undo]");
        process.exit(1);
      }
      await cmdRm(config, prefix, undo);
      break;
    }

    case "prune": {
      const all = args.includes("--all");
      const daysIdx = args.indexOf("--days");
      const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1] ?? "30", 10) : 30;
      await cmdPrune(config, days, all);
      break;
    }

    case "deleted": {
      const local = args.includes("--local");
      const hostIdx = args.indexOf("--host");
      const host = hostIdx >= 0 ? (args[hostIdx + 1] ?? null) : null;
      await cmdDeleted(config, { local, host });
      break;
    }

    case "purge": {
      const yes = args.includes("--yes");
      const all = args.includes("--all");
      const deletedOnly = args.includes("--deleted");
      const hostIdx = args.indexOf("--host");
      const purgeHost = hostIdx >= 0 ? (args[hostIdx + 1] ?? null) : null;
      const pattern = args.filter((a) => !a.startsWith("--") && a !== purgeHost)[1];
      if (!pattern) {
        console.error("Usage: cs purge <pattern> [--yes] [--all] [--host <name>] [--deleted]");
        process.exit(1);
      }
      await cmdPurge(config, pattern, yes, all, purgeHost, deletedOnly);
      break;
    }

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
