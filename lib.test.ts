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
  shortId,
  tmuxName,
  shellQuote,
  relativeTime,
  formatBytes,
  padRight,
  formatTable,
  redactUri,
  stateColor,
  SCHEMA_VERSION,
  hostnameVariants,
} from "./lib";

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
    const f = purgeBulkFilter("*", { host: "ndao.example.com", deletedOnly: true });
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

describe("hostnameVariants", () => {
  test("returns short name for FQDN", () => {
    expect(hostnameVariants("ndao.bogometer.com")).toEqual(["ndao"]);
  });
  test("returns empty for short name", () => {
    expect(hostnameVariants("LAKEDEV")).toEqual([]);
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
