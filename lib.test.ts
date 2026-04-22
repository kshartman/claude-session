import { describe, test, expect } from "bun:test";
import {
  decodePathHash,
  detectState,
  matchPrefix,
  shortId,
  tmuxName,
  shellQuote,
  relativeTime,
  padRight,
  formatTable,
  redactUri,
  stateColor,
  SCHEMA_VERSION,
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

// --- schema version ---

describe("schema", () => {
  test("SCHEMA_VERSION is 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
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
