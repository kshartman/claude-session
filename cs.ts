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
  const colWidths = [12, 8, 8, 10, 30];

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
        dim(shortId(s.session_id)),
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
        ? opts.host
        : { $regex: `^${escapeRegex(opts.host)}(\\.|\$)` };
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
    const colWidths = [12, 8, 8, 8, 10, 30];
    const rows = results.map((s) => {
      const proj = s.project_name.length > 12 ? s.project_name.slice(0, 11) + ">" : s.project_name;
      const title = s.title ?? "(no title)";
      const truncTitle = title.length > 30 ? title.slice(0, 29) + ">" : title;
      return [
        staleText(proj, s.updated_at),
        dim(shortId(s.session_id)),
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
  prefix: string
): Promise<SessionRecord> {
  return withDb(config, async (_db, sessions) => {
    // Try by session ID prefix first
    const byId = await sessions
      .find({ session_id: { $regex: `^${escapeRegex(prefix)}` }, deleted_at: null })
      .toArray();

    let matches = matchPrefix(byId, prefix);

    // If no ID match, try by title (from /rename)
    if (matches.length === 0) {
      matches = await sessions
        .find({ title: prefix, deleted_at: null })
        .toArray();
    }

    // Still nothing? Try title as substring (case-insensitive)
    if (matches.length === 0) {
      matches = await sessions
        .find({ title: { $regex: escapeRegex(prefix), $options: "i" }, deleted_at: null })
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
    const prefixResult = await tmuxRun("show-options", "-gv", "prefix");
    const prefix = prefixResult.exitCode === 0 && prefixResult.stdout ? prefixResult.stdout.trim() : "C-b";
    const keyMap: Record<string, string> = {
      "C-b": "Ctrl-b", "C-a": "Ctrl-a", "C-^": "Ctrl-6", "C-s": "Ctrl-s", "C-q": "Ctrl-q",
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

  await tmuxRun("set-option", "-t", tmuxSession, "status-left-length", "120");
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

  if (session.machine === machine) {
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
    }

    await configureTmuxBar(config, tmuxSession);

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

    // Step 1: ensure tmux session exists on remote + configure status bar
    const detachHint = config.showDetachHint ? await getDetachHint() : "";
    const statusLeft = detachHint
      ? `[${tmuxSession}] detach: ${detachHint}`
      : `[${tmuxSession}]`;

    const barCmds =
      `tmux set-option -t '${tmuxSession}' window-status-format '' 2>/dev/null; ` +
      `tmux set-option -t '${tmuxSession}' window-status-current-format '' 2>/dev/null; ` +
      `tmux set-option -t '${tmuxSession}' status-right '' 2>/dev/null; ` +
      `tmux set-option -t '${tmuxSession}' status-left-length 80 2>/dev/null; ` +
      `tmux set-option -t '${tmuxSession}' status-left ' ${statusLeft}' 2>/dev/null`;

    // Write a helper script on the remote to avoid quoting hell
    const script = [
      `#!/bin/bash`,
      `source ~/.bash_profile 2>/dev/null || source ~/.bashrc 2>/dev/null`,
      `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`,
      `tmux has-session -t '${tmuxSession}' 2>/dev/null && exit 0`,
      `cd '${session.project_path}' 2>/dev/null`,
      `tmux new-session -d -s '${tmuxSession}' claude --resume '${session.session_id}'`,
      barCmds,
    ].join("\n");

    const ensure = Bun.spawn([
      "ssh", session.machine, "bash", "-s",
    ], {
      stdin: new Response(script),
      stdout: "pipe",
      stderr: "pipe",
    });
    await ensure.exited;

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

async function cmdDeleted(config: CsConfig): Promise<void> {
  await withDb(config, async (_db, sessions) => {
    const results = await sessions
      .find({ deleted_at: { $ne: null } })
      .sort({ deleted_at: -1 })
      .limit(50)
      .toArray();

    if (results.length === 0) {
      console.log("No deleted sessions.");
      return;
    }

    const headers = ["HOST", "PROJECT", "TITLE", "DELETED", "ID"];
    const colWidths = [14, 14, 30, 12, 8];
    const rows = results.map((s) => [
      machineColor(config.listFQDN ? s.machine : s.machine.split(".")[0]!),
      s.project_name,
      s.title ?? dim("(no title)"),
      relativeTime(s.deleted_at!),
      dim(shortId(s.session_id)),
    ]);

    console.log(formatTable(headers, rows, colWidths));
  });
}

async function cmdPurge(
  config: CsConfig,
  prefix: string,
  confirm: boolean
): Promise<void> {
  // Resolve including deleted records
  const session = await withDb(config, async (_db, sessions) => {
    const all = await sessions
      .find({ $or: [
        { session_id: { $regex: `^${escapeRegex(prefix)}` } },
        { title: prefix },
        { title: { $regex: escapeRegex(prefix), $options: "i" } },
      ]})
      .toArray();

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
    return matches[0]!;
  });

  // Build the JSONL path
  const claudeDir = join(homedir(), ".claude", "projects");
  const pathHash = `-${session.project_path.slice(1).replace(/[/.]/g, "-")}`;
  const jsonlPath = join(claudeDir, pathHash, `${session.session_id}.jsonl`);
  const sessionDir = join(claudeDir, pathHash, session.session_id);

  const isLocal = session.machine === hostname();

  if (!confirm) {
    console.log(`Would purge:\n`);
    console.log(`  Session:  ${session.title ?? shortId(session.session_id)}`);
    console.log(`  Host:     ${session.machine}`);
    console.log(`  Project:  ${session.project_path}`);
    console.log(`  JSONL:    ${existsSync(jsonlPath) ? jsonlPath : dim("(not on this host)")}`);
    console.log(`  Dir:      ${existsSync(sessionDir) ? sessionDir : dim("(not on this host)")}`);
    console.log(`  MongoDB:  record will be deleted`);
    if (!isLocal) {
      console.log(yellow(`\n  WARNING: session is on ${session.machine} — run cs purge there to delete files`));
    }
    console.log(`\nRun with --yes to confirm.`);
    return;
  }

  if (!isLocal) {
    console.error(`Cannot purge: session is on ${session.machine}, not this host.`);
    console.error(`SSH to ${session.machine} and run cs purge there.`);
    process.exit(1);
  }

  // Kill tmux session if running
  if (session.tmux_session) {
    await tmuxRun("kill-session", "-t", session.tmux_session);
  }
  const tmuxSession = tmuxName(session.session_id, session.title, session.project_name);
  await tmuxRun("kill-session", "-t", tmuxSession);

  // Delete local files
  const { rmSync } = await import("fs");
  if (existsSync(jsonlPath)) {
    rmSync(jsonlPath);
    console.log(`  Deleted ${jsonlPath}`);
  }
  if (existsSync(sessionDir)) {
    rmSync(sessionDir, { recursive: true });
    console.log(`  Deleted ${sessionDir}/`);
  }

  // Hard delete from MongoDB
  await withDb(config, async (_db, sessions) => {
    await sessions.deleteOne({ session_id: session.session_id, machine: session.machine });
  });

  console.log(`  Purged ${red(session.title ?? shortId(session.session_id))} from ${session.machine}`);
}

const BASE_URL = "https://git.bogometer.com/shartman/claude-session/-/raw/main";

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
  cs hosts                        List hosts with session counts
  cs rm <id-or-name>              Soft-delete a session
  cs rm --undo <id-or-name>       Restore a soft-deleted session
  cs prune [--days N] [--all]     Bulk soft-delete unnamed/untagged sessions
  cs deleted                      List soft-deleted sessions
  cs purge <id-or-name> [--yes]   Hard delete session + local files (irreversible)
  cs update                       Update cs to latest version
  cs version                      Show current version

${bold("List options:")}
  --local                         This host only
  --host <hostname>               Filter by host
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

  if (command === "update") {
    await cmdUpdate();
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

    case "deleted":
      await cmdDeleted(config);
      break;

    case "purge": {
      const yes = args.includes("--yes");
      const prefix = args.filter((a) => a !== "--yes")[1];
      if (!prefix) {
        console.error("Usage: cs purge <id-or-name> [--yes]");
        process.exit(1);
      }
      await cmdPurge(config, prefix, yes);
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
