#!/usr/bin/env bun
// Render the command reference from commands.ts into cs.1 and README.md.
//
//   bun scripts/gen-docs.ts           # rewrite the generated blocks in place
//   bun scripts/gen-docs.ts --check   # exit non-zero if either is out of date
//
// Only the region between the BEGIN/END markers in each file is touched;
// everything else (NAME, DESCRIPTION, INSTALLATION, EXAMPLES, the README intro
// and config tables) stays hand-written.
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  COMMANDS,
  type CommandDoc,
  type CommandVariant,
  type DefItem,
  type DocBlock,
} from "../commands";

const check = process.argv.includes("--check");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- inline markup ---

/**
 * Escape text for roff: backslashes, hyphens (so `--host` stays a literal
 * minus and is copy-pasteable), em dashes, and a leading dot or apostrophe
 * (which roff would read as a control line).
 */
function roffEscape(text: string): string {
  return text
    .replace(/\\/g, "\\e")
    .replace(/-/g, "\\-")
    .replace(/—/g, "\\(em")
    .replace(/^([.'])/, "\\&$1");
}

/** `code` and **bold** both render bold in roff; name(1) bolds the name. */
function roffInline(text: string): string {
  return roffEscape(text)
    .replace(/`([^`]+)`/g, "\\fB$1\\fP")
    .replace(/\*\*([^*]+)\*\*/g, "\\fB$1\\fP")
    .replace(/\b([a-z][a-z0-9_\\-]*)\((\d)\)/g, "\\fB$1\\fP($2)");
}

/**
 * Markdown keeps the source markup as-is. Man-page cross references are a roff
 * convention, so `ssh(1)` degrades to plain "ssh" in the README.
 */
function mdInline(text: string): string {
  return text.replace(/\b([a-z][a-z0-9_-]*)\((\d)\)/g, "$1");
}

/** Wrap roff source at a readable width. Font escapes survive line breaks. */
function wrap(text: string, width = 78): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * Fail loudly on spec shapes the renderers would silently drop, rather than
 * quietly emitting docs that are missing an argument list.
 */
function validate(): void {
  const seen = new Set<string>();
  for (const cmd of COMMANDS) {
    if (seen.has(cmd.id)) {
      console.error(`Duplicate command id in commands.ts: ${cmd.id}`);
      process.exit(1);
    }
    seen.add(cmd.id);
    if (cmd.alias && cmd.args) {
      console.error(
        `Command "${cmd.id}" sets both alias and args; the header renderer can only show one.`
      );
      process.exit(1);
    }
    if (cmd.options && cmd.optionsFrom) {
      console.error(`Command "${cmd.id}" sets both options and optionsFrom.`);
      process.exit(1);
    }
  }
}

/** Variants that get their own reference entry, not just a `--help` line. */
function documentedVariants(cmd: CommandDoc): CommandVariant[] {
  return (cmd.variants ?? []).filter((v) => v.inDocs);
}

/** Shared wording for a command that borrows another's option list. */
function optionsPointer(from: string): string {
  return `Takes the same filter and sort options as \`${from}\`.`;
}

// --- man page ---

/** `.BI "cs purge" " <pattern>..."` — name bold, args italic. */
function manHeader(cmd: CommandDoc): string {
  const name = roffEscape(cmd.name);
  if (cmd.alias) {
    return `.BR "${name}" ", " "${roffEscape(cmd.alias)}"`;
  }
  return cmd.args
    ? `.BI "${name}" " ${roffEscape(cmd.args)}"`
    : `.B ${name}`;
}

function manDefs(defs: DefItem[]): string[] {
  const out: string[] = [];
  for (const d of defs) {
    const term = roffEscape(d.term);
    const space = term.indexOf(" ");
    out.push(".TP");
    // Split "--host <name>" so the flag is bold and its argument italic.
    out.push(
      space > 0
        ? `.BI ${term.slice(0, space)} " ${term.slice(space + 1)}"`
        : `.B ${term}`
    );
    out.push(...wrap(roffInline(d.desc)));
  }
  return out;
}

function manCommand(cmd: CommandDoc): string[] {
  const out: string[] = [".TP", manHeader(cmd)];
  const [first, ...rest] = cmd.details;
  if (first && "p" in first) out.push(...wrap(roffInline(first.p)));

  // Everything after the opening paragraph has to be indented under the .TP.
  const tail: DocBlock[] = first && "p" in first ? rest : cmd.details;
  const indented: string[] = [];
  for (const block of tail) {
    if ("p" in block) indented.push(".PP", ...wrap(roffInline(block.p)));
    else indented.push(...manDefs(block.defs));
  }
  if (cmd.optionsFrom) {
    indented.push(".PP", ...wrap(roffInline(optionsPointer(cmd.optionsFrom))));
  }
  if (cmd.options) indented.push(...manDefs(cmd.options));
  if (indented.length) out.push(".RS", ...indented, ".RE");
  return out;
}

function renderMan(): string {
  return COMMANDS.flatMap((cmd) => [
    ...manCommand(cmd),
    ...documentedVariants(cmd).flatMap((v) => [
      ".TP",
      v.args
        ? `.BI "${roffEscape(v.name)}" " ${roffEscape(v.args)}"`
        : `.B ${roffEscape(v.name)}`,
      ...wrap(roffInline(v.desc ?? v.summary)),
    ]),
  ]).join("\n");
}

// --- README ---

function renderReadme(): string {
  const out: string[] = [];
  for (const cmd of COMMANDS) {
    if (cmd.id === "help") continue; // `--help` needs no README section
    const heading = cmd.alias
      ? `\`${cmd.name}\`, \`${cmd.alias}\``
      : `\`${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}\``;
    out.push(`### ${heading}`, "");
    for (const block of cmd.details) {
      if ("p" in block) {
        out.push(mdInline(block.p), "");
      } else {
        for (const d of block.defs) out.push(`- **${d.term}** — ${mdInline(d.desc)}`);
        out.push("");
      }
    }
    if (cmd.optionsFrom) out.push(mdInline(optionsPointer(cmd.optionsFrom)), "");
    if (cmd.options) {
      for (const o of cmd.options) out.push(`- \`${o.term}\` — ${mdInline(o.desc)}`);
      out.push("");
    }
    if (cmd.examples) {
      out.push("```bash", ...cmd.examples, "```", "");
    }
    for (const v of documentedVariants(cmd)) {
      out.push(
        `### \`${v.name}${v.args ? ` ${v.args}` : ""}\``,
        "",
        mdInline(v.desc ?? v.summary),
        ""
      );
    }
  }
  return out.join("\n").trimEnd();
}

// --- splice ---

function splice(
  path: string,
  begin: string,
  end: string,
  body: string
): { changed: boolean; next: string } {
  const current = readFileSync(path, "utf-8");
  const startIdx = current.indexOf(begin);
  const endIdx = current.indexOf(end);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    console.error(`Missing or malformed generation markers in ${path}`);
    process.exit(1);
  }
  const next =
    current.slice(0, startIdx + begin.length) +
    "\n" +
    body +
    "\n" +
    current.slice(endIdx);
  return { changed: next !== current, next };
}

validate();

const targets = [
  {
    path: join(root, "cs.1"),
    begin: '.\\" BEGIN GENERATED COMMANDS — edit commands.ts, run: bun scripts/gen-docs.ts',
    end: '.\\" END GENERATED COMMANDS',
    body: renderMan(),
  },
  {
    path: join(root, "README.md"),
    begin: "<!-- BEGIN GENERATED COMMANDS — edit commands.ts, run: bun scripts/gen-docs.ts -->",
    end: "<!-- END GENERATED COMMANDS -->",
    body: renderReadme(),
  },
];

const stale: string[] = [];
for (const t of targets) {
  const { changed, next } = splice(t.path, t.begin, t.end, t.body);
  if (!changed) continue;
  stale.push(t.path.slice(root.length + 1));
  if (!check) writeFileSync(t.path, next);
}

if (check) {
  if (stale.length) {
    console.error(
      `Command docs are stale vs commands.ts: ${stale.join(", ")}\n` +
        `Run: bun scripts/gen-docs.ts`
    );
    process.exit(1);
  }
  console.log(`Command docs OK (${COMMANDS.length} commands)`);
} else {
  console.log(
    stale.length
      ? `Regenerated command docs in ${stale.join(", ")} (${COMMANDS.length} commands)`
      : `Command docs already current (${COMMANDS.length} commands)`
  );
}
