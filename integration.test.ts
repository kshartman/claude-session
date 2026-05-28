// DB-backed integration test for the destructive filters (prune / purge --all).
// Exercises the SAME pruneFilter/purgeBulkFilter the commands use, against a
// real MongoDB, on a throwaway collection that is dropped afterward.
//
// Connection comes from CS_TEST_MONGO_URI, or a gitignored ./.test-mongo-uri
// file. When neither is present the whole suite skips, so plain `bun test`
// still runs anywhere.
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { MongoClient, type Collection } from "mongodb";
import { type SessionRecord, pruneFilter, purgeBulkFilter } from "./lib";

function getTestUri(): string | null {
  if (process.env["CS_TEST_MONGO_URI"]) return process.env["CS_TEST_MONGO_URI"]!;
  try {
    return readFileSync(new URL("./.test-mongo-uri", import.meta.url), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

const TEST_URI = getTestUri();
const MACHINE = "testhost";
const OLD = new Date("2020-01-01T00:00:00Z"); // older than any age cutoff
const DEL = new Date("2020-06-01T00:00:00Z");

function mkRec(over: Partial<SessionRecord> & { session_id: string }): SessionRecord {
  return {
    _v: 2,
    machine: MACHINE,
    project_path: "/tmp/proj",
    project_name: "proj",
    started_at: OLD,
    updated_at: OLD,
    message_count: 1,
    title: over.title ?? "first message",
    agent_name: null,
    tag: null,
    state: null,
    tmux_session: null,
    summary: null,
    synced_at: OLD,
    deleted_at: null,
    ...over,
  };
}

// The five-case matrix the model is built on.
const FIXTURES = [
  mkRec({ session_id: "f1-named-live", agent_name: "kept-name", title: "kept project" }),
  mkRec({ session_id: "f2-tagged-live", tag: "keepme" }),
  mkRec({ session_id: "f3-plain-live" }),
  mkRec({ session_id: "f4-named-deleted", agent_name: "kept-name2", deleted_at: DEL }),
  mkRec({ session_id: "f5-plain-deleted", deleted_at: DEL }),
];

const ids = (rows: SessionRecord[]) => rows.map((r) => r.session_id).sort();

const run = TEST_URI ? describe : describe.skip;

run("integration: prune/purge filters against real MongoDB", () => {
  let client: MongoClient;
  let col: Collection<SessionRecord>;

  beforeAll(async () => {
    client = new MongoClient(TEST_URI!, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    col = client.db().collection<SessionRecord>("sessions_test");
  });

  beforeEach(async () => {
    await col.deleteMany({});
    await col.insertMany(FIXTURES.map((f) => ({ ...f })));
  });

  afterAll(async () => {
    if (col) await col.drop().catch(() => {});
    if (client) await client.close();
  });

  test("prune selects only the unnamed/untagged live session", async () => {
    const found = await col.find(pruneFilter(MACHINE, { days: 30, all: true })).toArray();
    expect(ids(found)).toEqual(["f3-plain-live"]);
  });

  test("purge --all '*' skips live named/tagged, keeps trashed ones", async () => {
    const found = await col.find(purgeBulkFilter("*", { host: MACHINE, deletedOnly: false })).toArray();
    // live plain + both soft-deleted; NEVER the live named/tagged ones
    expect(ids(found)).toEqual(["f3-plain-live", "f4-named-deleted", "f5-plain-deleted"]);
  });

  test("a pattern matching a live named session still cannot reach it", async () => {
    // "kept" matches fixture 1's title, but the guard excludes it because it is
    // named + live — proving a wildcard/pattern can't hard-delete a kept session.
    const found = await col.find(purgeBulkFilter("kept", { host: MACHINE, deletedOnly: false })).toArray();
    expect(ids(found)).not.toContain("f1-named-live");
  });

  test("purge --deleted --all only reaches the trash", async () => {
    const found = await col.find(purgeBulkFilter("*", { host: MACHINE, deletedOnly: true })).toArray();
    expect(ids(found)).toEqual(["f4-named-deleted", "f5-plain-deleted"]);
  });

  test("end-to-end: real prune updateMany flips exactly the right doc", async () => {
    await col.updateMany(pruneFilter(MACHINE, { days: 30, all: true }), { $set: { deleted_at: new Date() } });
    const stillLive = await col.find({ deleted_at: null }).toArray();
    // f1 (named) and f2 (tagged) survive; f3 got soft-deleted
    expect(ids(stillLive)).toEqual(["f1-named-live", "f2-tagged-live"]);
  });
});
