// --- types ---

// VERSION is set here and in the VERSION file — keep in sync when releasing
export const VERSION = "1.2.5";
export const SCHEMA_VERSION = 1;

export type SessionState = "WORKING" | "WAITING" | "IDLE" | "DEAD";

export interface SessionRecord {
  _v: number;
  session_id: string;
  machine: string;
  project_path: string;
  project_name: string;
  started_at: Date;
  updated_at: Date;
  message_count: number;
  title: string | null;
  tag: string | null;
  state: SessionState | null;
  tmux_session: string | null;
  summary: string | null;
  synced_at: Date;
  deleted_at: Date | null;
}

export interface CsConfig {
  mongoUri: string;
  showDetachHint?: boolean;
  listFQDN?: boolean;
}

// --- config ---

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_DIR = join(homedir(), ".config", "cs");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function loadConfig(): CsConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new ConfigError(
      `Config not found at ${CONFIG_PATH}\n\n` +
        `Create it with:\n` +
        `  mkdir -p ~/.config/cs\n` +
        `  cat > ~/.config/cs/config.json << 'EOF'\n` +
        `  {\n` +
        `    "mongoUri": "mongodb://claude:<password>@mdb.bogometer.com:27017/claude?authMechanism=SCRAM-SHA-256&tls=true"\n` +
        `  }\n` +
        `  EOF\n` +
        `  chmod 600 ~/.config/cs/config.json`
    );
  }

  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    throw new ConfigError(`Cannot read config at ${CONFIG_PATH}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ConfigError(`Invalid JSON in ${CONFIG_PATH}`);
  }

  if (typeof parsed["mongoUri"] !== "string" || !parsed["mongoUri"]) {
    throw new ConfigError(`Missing "mongoUri" in ${CONFIG_PATH}`);
  }

  return {
    mongoUri: parsed["mongoUri"],
    showDetachHint: parsed["showDetachHint"] === true,
    listFQDN: parsed["listFQDN"] !== false,
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function redactUri(uri: string): string {
  return uri.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
}

// --- colors ---

const NO_COLOR = !!process.env["NO_COLOR"];

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
} as const;

function c(code: keyof typeof ANSI, text: string): string {
  if (NO_COLOR) return text;
  return `${ANSI[code]}${text}${ANSI.reset}`;
}

export function bold(text: string): string {
  return c("bold", text);
}
export function dim(text: string): string {
  return c("dim", text);
}
export function red(text: string): string {
  return c("red", text);
}
export function green(text: string): string {
  return c("green", text);
}
export function yellow(text: string): string {
  return c("yellow", text);
}
export function blue(text: string): string {
  return c("blue", text);
}
export function magenta(text: string): string {
  return c("magenta", text);
}
export function cyan(text: string): string {
  return c("cyan", text);
}

const MACHINE_COLORS: Array<keyof typeof ANSI> = [
  "cyan",
  "magenta",
  "blue",
  "yellow",
  "green",
];

const machineColorCache = new Map<string, keyof typeof ANSI>();
let nextColorIdx = 0;

export function machineColor(machine: string): string {
  let color = machineColorCache.get(machine);
  if (!color) {
    color = MACHINE_COLORS[nextColorIdx % MACHINE_COLORS.length]!;
    machineColorCache.set(machine, color);
    nextColorIdx++;
  }
  return c(color, machine);
}

export function stateColor(state: SessionState | null): string {
  if (!state) return dim("unknown");
  switch (state) {
    case "WORKING":
      return green(state);
    case "WAITING":
      return yellow(state);
    case "IDLE":
      return dim(state);
    case "DEAD":
      return red(state);
  }
}

export function staleText(text: string, updatedAt: Date): string {
  const ageMs = Date.now() - updatedAt.getTime();
  const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours
  return ageMs > staleThreshold ? dim(text) : text;
}

// --- time formatting ---

export function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}

// --- path decoding ---

export function decodePathHash(hash: string): string {
  // e.g. "-home-bogometer-com-shartman-projects-cs" → "/home/bogometer.com/shartman/projects/cs"
  // The hash replaces "/" with "-" and "." with "-"
  // We need to reconstruct — replace leading "-" with "/", then remaining "-" with "/"
  // But this is lossy (hyphens in actual dir names). So we validate against filesystem.
  if (!hash.startsWith("-")) return hash;
  return hash.replace(/^-/, "/").replace(/-/g, "/");
}

export function findValidProjectPath(hash: string): string | null {
  const naive = decodePathHash(hash);
  if (existsSync(naive)) return naive;

  // Try common patterns where "-" might be "." (e.g., bogometer.com → bogometer-com)
  // Walk segments and try "." replacements
  const segments = hash.slice(1).split("-"); // remove leading "-"
  return tryReconstruct(segments, 0, "");
}

function tryReconstruct(
  segments: string[],
  idx: number,
  current: string
): string | null {
  if (idx >= segments.length) {
    return current && existsSync(current) ? current : null;
  }

  const seg = segments[idx]!;

  // Try appending as a new path segment
  const asSegment = current ? `${current}/${seg}` : `/${seg}`;
  const result1 = tryReconstruct(segments, idx + 1, asSegment);
  if (result1) return result1;

  // Try joining with previous segment via "." (e.g., bogometer.com)
  if (current) {
    const asDot = `${current}.${seg}`;
    const result2 = tryReconstruct(segments, idx + 1, asDot);
    if (result2) return result2;
  }

  // Try joining with previous segment via "-" (e.g., my-project)
  if (current) {
    const asHyphen = `${current}-${seg}`;
    const result3 = tryReconstruct(segments, idx + 1, asHyphen);
    if (result3) return result3;
  }

  return null;
}

// --- jsonl parsing ---

export interface JsonlParseResult {
  messageCount: number;
  title: string | null;
  sessionName: string | null;
  startedAt: Date | null;
}

export async function parseSessionJsonl(
  filePath: string
): Promise<JsonlParseResult> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  let messageCount = 0;
  let title: string | null = null;
  let sessionName: string | null = null;
  let startedAt: Date | null = null;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;

      // Count user and assistant messages (not tool results, not snapshots)
      if (obj["type"] === "user" || obj["type"] === "assistant") {
        messageCount++;
      }

      // Extract session name set via /rename (stored as agentName)
      if (typeof obj["agentName"] === "string" && obj["agentName"]) {
        sessionName = obj["agentName"];
      }

      // Extract first human message as title
      if (title === null && obj["type"] === "user") {
        const message = obj["message"] as Record<string, unknown> | undefined;
        if (message) {
          const content = message["content"];
          if (typeof content === "string") {
            title = content.slice(0, 80);
          } else if (Array.isArray(content)) {
            // content can be an array of blocks, find text
            for (const block of content) {
              if (
                typeof block === "object" &&
                block !== null &&
                "text" in block &&
                typeof (block as Record<string, unknown>)["text"] === "string"
              ) {
                title = (
                  (block as Record<string, unknown>)["text"] as string
                ).slice(0, 80);
                break;
              }
            }
          }
        }
      }

      // Extract earliest timestamp
      if (obj["timestamp"] && typeof obj["timestamp"] === "string") {
        const ts = new Date(obj["timestamp"] as string);
        if (!isNaN(ts.getTime()) && (!startedAt || ts < startedAt)) {
          startedAt = ts;
        }
      }
    } catch {
      // Malformed line — skip silently
      continue;
    }
  }

  return { messageCount, title, sessionName, startedAt };
}

// --- summary reading ---

export async function readSummary(
  projectDir: string,
  sessionId: string
): Promise<string | null> {
  const summaryPath = join(
    projectDir,
    sessionId,
    "session-memory",
    "summary.md"
  );
  try {
    const content = await Bun.file(summaryPath).text();
    return content.slice(0, 200) || null;
  } catch {
    return null;
  }
}

// --- state detection ---

export function detectState(paneContent: string): SessionState | null {
  const lines = paneContent.trim().split("\n");
  const lastLines = lines.slice(-15).join("\n");

  // WORKING takes priority — if there's an active spinner, Claude is generating
  // even if a prompt (❯) is also visible on screen
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓⣾⣽⣻⢿⡿⣟⣯⣷]/.test(lastLines)) {
    return "WORKING";
  }

  // WORKING: "Running…", "Infusing…", "Thinking…" etc
  if (/\w+…/.test(lastLines)) {
    return "WORKING";
  }

  // WORKING: streaming ellipsis
  if (/\.\.\.$/.test(lastLines.trim())) {
    return "WORKING";
  }

  // WAITING: Claude is asking for permission
  if (
    /\b(allow|deny|yes\/no|y\/n|\[Y\/n\]|\[y\/N\]|permission|approve)\b/i.test(
      lastLines
    )
  ) {
    return "WAITING";
  }

  // WAITING: Claude prompt waiting for user input (❯ on its own line)
  if (/^❯\s*$/m.test(lastLines)) {
    return "WAITING";
  }

  // IDLE: has content but nothing active
  if (lastLines.trim().length > 0) {
    return "IDLE";
  }

  return null;
}

// --- prefix matching ---

export function matchPrefix<T extends { session_id: string }>(
  records: T[],
  prefix: string
): T[] {
  return records.filter((r) => r.session_id.startsWith(prefix));
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

// --- table formatting ---

export function padRight(str: string, len: number): string {
  // Strip ANSI codes for length calculation
  const visible = str.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, len - visible.length);
  return str + " ".repeat(pad);
}

export function formatTable(
  headers: string[],
  rows: string[][],
  colWidths: number[]
): string {
  const headerLine = headers
    .map((h, i) => padRight(bold(h), colWidths[i]!))
    .join("  ");
  const separator = colWidths.map((w) => "─".repeat(w)).join("──");
  const dataLines = rows.map((row) =>
    row.map((cell, i) => padRight(cell, colWidths[i]!)).join("  ")
  );
  return [headerLine, separator, ...dataLines].join("\n");
}

// --- tmux session name ---

export function tmuxName(
  sessionId: string,
  title: string | null,
  projectName: string | null
): string {
  if (title) {
    // Sanitize for tmux (no dots or colons — tmux uses these as separators)
    return title.replace(/[.:]/g, "-").slice(0, 40);
  }
  if (projectName) {
    return `${projectName}-${shortId(sessionId)}`;
  }
  return shortId(sessionId);
}
