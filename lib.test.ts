import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  decodePathHash,
  encodePathHash,
  parseSessionJsonl,
  pruneFilter,
  purgeBulkFilter,
  isKeepSignalProtected,
  escapeRegex,
  detectState,
  matchPrefix,
  parseArgs,
  parsePositiveInt,
  sameProjectCandidates,
  parsePickChoice,
  shortId,
  tmuxName,
  shellQuote,
  relativeTime,
  formatBytes,
  padRight,
  formatTable,
  redactUri,
  stateColor,
  colorEnabled,
  SCHEMA_VERSION,
  hostnameVariants,
  sshHostCandidates,
  parseVersionOutput,
  parseChecksum,
  mirrorUrlProblem,
  crossCheckChecksums,
  firstLine,
} from "./lib";
import { ARG_SPECS, COMMANDS } from "./commands";

// --- config ---

describe("redactUri", () => {
  test("redacts password from MongoDB URI", () => {
    const uri = "mongodb://claude:s3cret@your-mongo-host:27017/claude";
    expect(redactUri(uri)).toBe("mongodb://claude:***@your-mongo-host:27017/claude");
  });

  test("handles URI without credentials", () => {
    const uri = "mongodb://localhost:27017/test";
    expect(redactUri(uri)).toBe("mongodb://localhost:27017/test");
  });
});

// --- path decoding ---

describe("decodePathHash", () => {
  test("decodes simple path hash", () => {
    expect(decodePathHash("-home-user-projects-myapp")).toBe(
      "/home/user/projects/myapp"
    );
  });

  test("returns non-prefixed strings as-is", () => {
    expect(decodePathHash("some-other-thing")).toBe("some-other-thing");
  });
});

describe("encodePathHash", () => {
  test("encodes a simple path", () => {
    expect(encodePathHash("/home/user/projects/myapp")).toBe(
      "-home-user-projects-myapp"
    );
  });

  test("round-trips with decodePathHash for hyphen-free paths", () => {
    const p = "/home/user/projects/myapp";
    expect(decodePathHash(encodePathHash(p))).toBe(p);
  });

  test("collapses dots to hyphens (lossy, like Claude's encoding)", () => {
    expect(encodePathHash("/home/user/example.com")).toBe(
      "-home-user-example-com"
    );
  });
});

// --- jsonl parsing ---

describe("parseSessionJsonl", () => {
  test("counts messages and extracts title, sessionName, earliest timestamp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-test-"));
    const file = join(dir, "s.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "user", message: { content: "first human message" }, timestamp: "2026-01-02T00:00:00Z" }),
        JSON.stringify({ type: "assistant", message: { content: "hi" }, timestamp: "2026-01-01T00:00:00Z" }),
        JSON.stringify({ type: "user", agentName: "my-renamed", message: { content: "second" }, timestamp: "2026-01-03T00:00:00Z" }),
        JSON.stringify({ type: "summary" }),
        "{ this line is malformed",
      ];
      writeFileSync(file, lines.join("\n") + "\n");
      const r = await parseSessionJsonl(file);
      expect(r.messageCount).toBe(3); // 2 user + 1 assistant; summary/malformed skipped
      expect(r.title).toBe("first human message");
      expect(r.sessionName).toBe("my-renamed");
      expect(r.startedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("extracts title from array-of-blocks content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-test-"));
    const file = join(dir, "s.jsonl");
    try {
      writeFileSync(file, JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "blocky title" }] } }) + "\n");
      const r = await parseSessionJsonl(file);
      expect(r.title).toBe("blocky title");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("skips a malformed partial tail line with no trailing newline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-test-"));
    const file = join(dir, "s.jsonl");
    try {
      writeFileSync(file, JSON.stringify({ type: "user", message: { content: "ok" } }) + '\n{"type":"user","mess');
      const r = await parseSessionJsonl(file);
      expect(r.messageCount).toBe(1);
      expect(r.title).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// --- state detection ---

describe("detectState", () => {
  test("detects WAITING from permission prompt", () => {
    const content = "Do you want to allow this tool? [Y/n]";
    expect(detectState(content)).toBe("WAITING");
  });

  test("detects WAITING from Claude input prompt", () => {
    const content = "some output\n❯\n";
    expect(detectState(content)).toBe("WAITING");
  });

  test("detects WORKING from spinner", () => {
    const content = "Thinking ⠋";
    expect(detectState(content)).toBe("WORKING");
  });

  test("detects WORKING from ellipsis", () => {
    const content = "Generating code...";
    expect(detectState(content)).toBe("WORKING");
  });

  test("detects IDLE from static content", () => {
    const content = "Task completed successfully.";
    expect(detectState(content)).toBe("IDLE");
  });

  test("returns null for empty content", () => {
    expect(detectState("")).toBeNull();
    expect(detectState("   \n  ")).toBeNull();
  });
});

// --- prefix matching ---

describe("matchPrefix", () => {
  const records = [
    { session_id: "abc12345-0000-0000-0000-000000000000" },
    { session_id: "abc12399-0000-0000-0000-000000000000" },
    { session_id: "def00000-0000-0000-0000-000000000000" },
  ];

  test("matches single prefix", () => {
    const result = matchPrefix(records, "def");
    expect(result).toHaveLength(1);
    expect(result[0]!.session_id).toStartWith("def");
  });

  test("matches multiple prefixes", () => {
    const result = matchPrefix(records, "abc123");
    expect(result).toHaveLength(2);
  });

  test("returns empty for no match", () => {
    const result = matchPrefix(records, "zzz");
    expect(result).toHaveLength(0);
  });

  test("exact prefix match", () => {
    const result = matchPrefix(records, "abc12345");
    expect(result).toHaveLength(1);
  });
});

describe("sameProjectCandidates", () => {
  const rec = (id: string, project: string, iso: string) => ({
    session_id: id,
    project_name: project,
    updated_at: new Date(iso),
  });

  test("same project: returns all, newest first", () => {
    const result = sameProjectCandidates([
      rec("old", "myapp", "2026-10-01T00:00:00Z"),
      rec("new", "myapp", "2026-10-03T00:00:00Z"),
      rec("mid", "myapp", "2026-10-02T00:00:00Z"),
    ]);
    expect(result?.map((r) => r.session_id)).toEqual(["new", "mid", "old"]);
  });

  test("mixed projects: null", () => {
    const result = sameProjectCandidates([
      rec("a", "myapp", "2026-10-01T00:00:00Z"),
      rec("b", "otherapp", "2026-10-02T00:00:00Z"),
    ]);
    expect(result).toBeNull();
  });

  test("empty input: null", () => {
    expect(sameProjectCandidates([])).toBeNull();
  });

  test("does not mutate input order", () => {
    const input = [rec("old", "myapp", "2026-10-01T00:00:00Z"), rec("new", "myapp", "2026-10-02T00:00:00Z")];
    sameProjectCandidates(input);
    expect(input[0]!.session_id).toBe("old");
  });
});

describe("parsePickChoice", () => {
  test("empty / newline selects default (first)", () => {
    expect(parsePickChoice("", 3)).toBe(0);
    expect(parsePickChoice("\n", 3)).toBe(0);
  });

  test("valid 1-based number → 0-based index", () => {
    expect(parsePickChoice("1\n", 3)).toBe(0);
    expect(parsePickChoice(" 3 ", 3)).toBe(2);
  });

  test("out of range or non-numeric → null", () => {
    expect(parsePickChoice("0", 3)).toBeNull();
    expect(parsePickChoice("4", 3)).toBeNull();
    expect(parsePickChoice("-1", 3)).toBeNull();
    expect(parsePickChoice("2x", 3)).toBeNull();
    expect(parsePickChoice("abc", 3)).toBeNull();
  });

  test("no candidates → null even for default", () => {
    expect(parsePickChoice("", 0)).toBeNull();
  });
});

// --- helpers ---

describe("shortId", () => {
  test("returns first 8 chars", () => {
    expect(shortId("abc12345-6789-0000-0000-000000000000")).toBe("abc12345");
  });
});

describe("tmuxName", () => {
  test("uses title when available", () => {
    expect(tmuxName("abc12345-6789-0000-0000-000000000000", "my-session", "myproject")).toBe("my-session");
  });

  test("uses project-shortid when no title", () => {
    expect(tmuxName("abc12345-6789-0000-0000-000000000000", null, "myproject")).toBe("myproject-abc12345");
  });

  test("uses shortid when no title or project", () => {
    expect(tmuxName("abc12345-6789-0000-0000-000000000000", null, null)).toBe("abc12345");
  });

  test("sanitizes special chars in title", () => {
    expect(tmuxName("abc12345-6789-0000-0000-000000000000", "my.session:v2", "proj")).toBe("my-session-v2");
    expect(tmuxName("abc12345-6789-0000-0000-000000000000", "read this project, understand", "proj")).toBe("read-this-project-understand");
  });
});

describe("relativeTime", () => {
  test("shows 'just now' for recent", () => {
    expect(relativeTime(new Date())).toBe("just now");
  });

  test("shows minutes", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(relativeTime(fiveMinAgo)).toBe("5m ago");
  });

  test("shows hours", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(relativeTime(threeHoursAgo)).toBe("3h ago");
  });

  test("shows days", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(relativeTime(twoDaysAgo)).toBe("2d ago");
  });
});

// --- size formatting ---

describe("formatBytes", () => {
  test("bytes under 1K", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1023)).toBe("1023B");
  });

  test("kilobytes", () => {
    expect(formatBytes(1024)).toBe("1K");
    expect(formatBytes(184 * 1024)).toBe("184K");
  });

  test("megabytes", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0M");
    expect(formatBytes(Math.round(2.5 * 1024 * 1024))).toBe("2.5M");
  });

  test("gigabytes", () => {
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0G");
  });
});

// --- table formatting ---

describe("padRight", () => {
  test("pads plain string", () => {
    expect(padRight("hi", 5)).toBe("hi   ");
  });

  test("strips ANSI for length calculation", () => {
    const colored = "\x1b[31mhi\x1b[0m"; // red "hi"
    const padded = padRight(colored, 5);
    // Should have 3 spaces of padding (visible "hi" = 2 chars)
    expect(padded).toBe(`${colored}   `);
  });
});

describe("formatTable", () => {
  test("formats basic table", () => {
    const result = formatTable(
      ["NAME", "AGE"],
      [["Alice", "30"], ["Bob", "25"]],
      [10, 5]
    );
    expect(result).toContain("NAME");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    expect(result).toContain("─");
  });
});

// --- mongo filters ---

describe("pruneFilter", () => {
  test("scopes to machine, live only, and excludes named + tagged", () => {
    const f = pruneFilter("host1", { days: 30, all: true });
    expect(f["machine"]).toBe("host1");
    expect(f["deleted_at"]).toBeNull();
    expect(f["$and"]).toEqual([
      { $or: [{ tag: null }, { tag: { $exists: false } }] },
      { $or: [{ agent_name: null }, { agent_name: { $exists: false } }] },
    ]);
  });

  test("--all ignores the age cutoff", () => {
    expect(pruneFilter("h", { days: 30, all: true })["updated_at"]).toBeUndefined();
  });

  test("applies an age cutoff when not --all", () => {
    const f = pruneFilter("h", { days: 7, all: false });
    expect(f["updated_at"]).toHaveProperty("$lt");
  });
});

describe("isKeepSignalProtected", () => {
  test("live named session is protected", () => {
    expect(isKeepSignalProtected({ deleted_at: null, agent_name: "my-sess", tag: null })).toBe(true);
  });

  test("live tagged session is protected", () => {
    expect(isKeepSignalProtected({ deleted_at: null, agent_name: null, tag: "wip" })).toBe(true);
  });

  test("live plain session is not protected", () => {
    expect(isKeepSignalProtected({ deleted_at: null, agent_name: null, tag: null })).toBe(false);
  });

  test("soft-deleted named session is not protected (already in trash)", () => {
    expect(isKeepSignalProtected({ deleted_at: new Date(), agent_name: "my-sess", tag: "wip" })).toBe(false);
  });
});

describe("purgeBulkFilter", () => {
  test("wildcard purge only carries the keep-guard clause", () => {
    const f = purgeBulkFilter("*", { deletedOnly: false });
    const and = f["$and"] as Record<string, unknown>[];
    expect(and).toHaveLength(1);
    // guard: already-trashed OR (not named AND not tagged)
    expect(and[0]).toEqual({
      $or: [
        { deleted_at: { $ne: null } },
        {
          $and: [
            { $or: [{ agent_name: null }, { agent_name: { $exists: false } }] },
            { $or: [{ tag: null }, { tag: { $exists: false } }] },
          ],
        },
      ],
    });
    expect(f["machine"]).toBeUndefined();
  });

  test("non-wildcard adds a pattern clause alongside the guard", () => {
    const and = purgeBulkFilter("foo", { deletedOnly: false })["$and"] as Record<string, unknown>[];
    expect(and).toHaveLength(2);
  });

  test("host and --deleted scope the query", () => {
    const f = purgeBulkFilter("*", { host: "host1.example.com", deletedOnly: true });
    expect(f["machine"]).toHaveProperty("$regex");
    expect(f["deleted_at"]).toEqual({ $ne: null });
  });
});

describe("escapeRegex", () => {
  test("escapes regex metacharacters", () => {
    expect(escapeRegex("a.b*c")).toBe("a\\.b\\*c");
  });
});

// --- schema version ---

describe("schema", () => {
  test("SCHEMA_VERSION is 2", () => {
    expect(SCHEMA_VERSION).toBe(2);
  });
});

// --- color functions ---

describe("shellQuote", () => {
  test("wraps in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });
  test("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  test("handles injection attempt", () => {
    expect(shellQuote("x'; rm -rf /; '")).toBe("'x'\\''; rm -rf /; '\\'''");
  });
  test("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
});

describe("sshHostCandidates", () => {
  test("FQDN yields stored, lowercase, short, short-lowercase", () => {
    expect(sshHostCandidates("HOST.example.com")).toEqual([
      "HOST.example.com",
      "host.example.com",
      "HOST",
      "host",
    ]);
  });
  test("uppercase short name yields both cases", () => {
    expect(sshHostCandidates("WORKSTATION")).toEqual(["WORKSTATION", "workstation"]);
  });
  test("already-lowercase short name yields one candidate", () => {
    expect(sshHostCandidates("dev")).toEqual(["dev"]);
  });
  test("lowercase FQDN does not repeat the stored form", () => {
    expect(sshHostCandidates("dev.example.com")).toEqual(["dev.example.com", "dev"]);
  });
});

describe("parseVersionOutput", () => {
  test("parses cs version output", () => {
    expect(parseVersionOutput("cs v1.9.1")).toBe("1.9.1");
  });
  test("parses a bare semver", () => {
    expect(parseVersionOutput("1.10.0\n")).toBe("1.10.0");
  });
  test("ignores surrounding noise", () => {
    expect(parseVersionOutput("warning: foo\ncs v2.0.13\n")).toBe("2.0.13");
  });
  test("returns null when there is no version", () => {
    expect(parseVersionOutput("command not found: cs")).toBeNull();
  });
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("parseChecksum", () => {
  test("takes the hash from sha256sum format", () => {
    expect(parseChecksum(`${HASH_A}  cs.bundle.js\n`)).toBe(HASH_A);
  });
  test("lowercases the hash", () => {
    expect(parseChecksum(HASH_A.toUpperCase())).toBe(HASH_A);
  });
  test("rejects a short hash", () => {
    expect(parseChecksum("abc123  cs.bundle.js")).toBeNull();
  });
  test("rejects non-hex content like an HTML error page", () => {
    expect(parseChecksum("<html><body>404</body></html>")).toBeNull();
  });
  test("rejects empty input", () => {
    expect(parseChecksum("")).toBeNull();
  });
});

describe("mirrorUrlProblem", () => {
  const primary = "https://raw.example.com/owner/repo/main";
  test("accepts a mirror on a different host", () => {
    expect(mirrorUrlProblem(primary, "https://git.example.org/owner/repo/-/raw/main")).toBeNull();
  });
  test("rejects a mirror on the primary's host", () => {
    expect(mirrorUrlProblem(primary, "https://raw.example.com/other/repo/main")).toContain("same host");
  });
  test("compares hosts case-insensitively", () => {
    expect(mirrorUrlProblem(primary, "https://RAW.Example.COM/x")).toContain("same host");
  });
  test("treats a different port as a different origin", () => {
    expect(mirrorUrlProblem(primary, "https://raw.example.com:8443/x")).toBeNull();
  });
  test("rejects an unparseable mirror URL", () => {
    expect(mirrorUrlProblem(primary, "not a url")).toContain("not a valid URL");
  });
});

describe("crossCheckChecksums", () => {
  test("trusts a checksum both origins agree on", () => {
    expect(crossCheckChecksums(`${HASH_A}  cs.bundle.js`, HASH_A.toUpperCase())).toEqual({ ok: true, hash: HASH_A });
  });
  test("refuses when the origins disagree", () => {
    const result = crossCheckChecksums(HASH_A, HASH_B);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("disagree");
  });
  test("refuses a malformed primary", () => {
    const result = crossCheckChecksums("garbage", HASH_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("primary");
  });
  test("refuses a malformed mirror", () => {
    const result = crossCheckChecksums(HASH_A, "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("mirror");
  });
});

describe("firstLine", () => {
  test("returns the first non-empty line", () => {
    expect(firstLine("\n  ssh: connect failed\nmore\n")).toBe("ssh: connect failed");
  });
  test("truncates past the cap", () => {
    expect(firstLine("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
  test("returns empty string for empty input", () => {
    expect(firstLine("   ")).toBe("");
  });
});

describe("hostnameVariants", () => {
  test("returns short name for FQDN", () => {
    expect(hostnameVariants("host.example.com")).toEqual(["host"]);
  });
  test("returns empty for short name", () => {
    expect(hostnameVariants("WORKSTATION")).toEqual([]);
  });
  test("handles multi-level domain", () => {
    expect(hostnameVariants("a.b.c.d")).toEqual(["a"]);
  });
});

describe("colors", () => {
  test("stateColor returns colored text", () => {
    // Just verify they don't throw
    expect(stateColor("WORKING")).toContain("WORKING");
    expect(stateColor("WAITING")).toContain("WAITING");
    expect(stateColor("IDLE")).toContain("IDLE");
    expect(stateColor("DEAD")).toContain("DEAD");
    expect(stateColor(null)).toContain("NONE");
  });
});

// --- argument checks ---

describe("parseArgs", () => {
  const spec = {
    flags: ["--all", "--yes"],
    values: ["--host"],
    optionalValues: ["--sort"],
    positionals: 1,
  } as const;

  function ok(args: string[]) {
    const r = parseArgs(args, spec);
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    return r.args;
  }
  function err(args: string[]): string {
    const r = parseArgs(args, spec);
    if (r.ok) throw new Error("expected an error");
    return r.error;
  }

  test("empty args", () => {
    const r = ok([]);
    expect(r.present.size).toBe(0);
    expect(r.positionals).toEqual([]);
  });

  test("flags, values, and positionals in any order", () => {
    const r = ok(["--all", "--host", "dev", "abc", "--yes"]);
    expect([...r.present].sort()).toEqual(["--all", "--host", "--yes"]);
    expect(r.values.get("--host")).toBe("dev");
    expect(r.positionals).toEqual(["abc"]);
  });

  test("a value equal to a positional does not swallow it", () => {
    // the old hand parser filtered positionals by `a !== host`
    const r = ok(["--host", "dev", "dev"]);
    expect(r.values.get("--host")).toBe("dev");
    expect(r.positionals).toEqual(["dev"]);
  });

  test("optional value: given, absent, or followed by a flag", () => {
    expect(ok(["--sort", "title"]).values.get("--sort")).toBe("title");
    const bare = ok(["--sort"]);
    expect(bare.present.has("--sort")).toBe(true);
    expect(bare.values.has("--sort")).toBe(false);
    const beforeFlag = ok(["--sort", "--all"]);
    expect(beforeFlag.values.has("--sort")).toBe(false);
    expect(beforeFlag.present.has("--all")).toBe(true);
  });

  test("optional value consumes a following word before positionals", () => {
    const r = ok(["--sort", "title", "extra"]);
    expect(r.values.get("--sort")).toBe("title");
    expect(r.positionals).toEqual(["extra"]);
  });

  test("rejects unknown and near-miss flags", () => {
    expect(err(["--al"])).toBe("unknown option --al");
    expect(err(["--All"])).toBe("unknown option --All");
    expect(err(["-all"])).toBe("unknown option -all");
    expect(err(["-"])).toBe("unknown option -");
  });

  test("value flag without a value", () => {
    expect(err(["--host"])).toBe("--host needs a value");
    expect(err(["--host", "--all"])).toBe("--host needs a value");
  });

  test("too many positionals names the first extra one", () => {
    expect(err(["abc", "def", "ghi"])).toBe("unexpected argument def");
  });

  test('"rest" allows any number of positionals', () => {
    const r = parseArgs(["a", "b", "c"], { positionals: "rest" });
    expect(r.ok && r.args.positionals).toEqual(["a", "b", "c"]);
  });
});

describe("parsePositiveInt", () => {
  test("accepts positive integers", () => {
    expect(parsePositiveInt("1")).toBe(1);
    expect(parsePositiveInt("40")).toBe(40);
    expect(parsePositiveInt("007")).toBe(7);
  });

  test("rejects zero, negatives, decimals, junk", () => {
    for (const s of ["0", "-3", "1.5", "10x", "abc", "", " 5"]) {
      expect(parsePositiveInt(s)).toBeNull();
    }
  });
});

describe("ARG_SPECS", () => {
  // Every doc entry for a dispatch word: "cs purge", "cs purge --orphans", ...
  function docText(key: string): string {
    const base = key === "" ? "cs" : `cs ${key}`;
    const parts: string[] = [];
    for (const c of COMMANDS) {
      if (c.name !== base && !c.name.startsWith(`${base} `)) continue;
      if (key === "" && c.name !== "cs") continue;
      parts.push(c.name, c.args ?? "", c.helpArgs ?? "");
      for (const v of c.variants ?? []) parts.push(v.name, v.args ?? "");
      for (const o of c.options ?? []) parts.push(o.term);
    }
    return parts.join(" ");
  }

  for (const [key, spec] of Object.entries(ARG_SPECS)) {
    const flags = [...(spec.flags ?? []), ...(spec.values ?? []), ...(spec.optionalValues ?? [])];
    test(`every flag for "cs ${key}" is documented`, () => {
      const text = docText(key);
      expect(text).not.toBe("");
      for (const f of flags) {
        expect(text).toMatch(new RegExp(`(^|[\\s\\[])${escapeRegex(f)}(?=[\\s\\]]|$)`));
      }
    });
  }

  test("every dispatched command has a spec", () => {
    const words = COMMANDS.map((c) => c.name.split(" ")[1])
      .filter((w): w is string => w !== undefined && !w.startsWith("-"));
    for (const w of new Set(words)) expect(ARG_SPECS[w]).toBeDefined();
  });
});

// --- colors ---

describe("colorEnabled", () => {
  test("terminal on both streams → color", () => {
    expect(colorEnabled({}, true, true)).toBe(true);
  });

  test("either stream captured or piped → no color", () => {
    expect(colorEnabled({}, false, true)).toBe(false);
    expect(colorEnabled({}, true, false)).toBe(false);
    expect(colorEnabled({}, false, false)).toBe(false);
  });

  test("NO_COLOR disables, and beats FORCE_COLOR", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, true, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, false, false)).toBe(false);
  });

  test("empty NO_COLOR is ignored", () => {
    expect(colorEnabled({ NO_COLOR: "" }, true, true)).toBe(true);
  });

  test("FORCE_COLOR enables for pipes; 0 or empty does not", () => {
    expect(colorEnabled({ FORCE_COLOR: "1" }, false, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" }, false, false)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "" }, false, false)).toBe(false);
  });
});
