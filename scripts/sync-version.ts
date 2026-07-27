#!/usr/bin/env bun
// Single-source the version. The VERSION file is canonical; this script copies
// it into the embedded constant in lib.ts, the "version" field in package.json,
// and the .TH header of cs.1 so a release is just "edit VERSION, run build".
//
//   bun scripts/sync-version.ts           # rewrite lib.ts + package.json + cs.1 to match VERSION
//   bun scripts/sync-version.ts --check   # exit non-zero if any are out of sync (no writes)
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const check = process.argv.includes("--check");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const version = readFileSync(join(root, "VERSION"), "utf-8").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`VERSION file is not semver: "${version}"`);
  process.exit(1);
}

const libPath = join(root, "lib.ts");
const lib = readFileSync(libPath, "utf-8");
const libMatch = lib.match(/export const VERSION = "([^"]*)";/);
if (!libMatch) {
  console.error("Could not find `export const VERSION` in lib.ts");
  process.exit(1);
}
const libVersion = libMatch[1];

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
const pkgVersion = pkg["version"];

// The man page carries the version in its .TH header, e.g.
//   .TH CS 1 "2026-07-27" "cs 1.9.0" "Claude Session Manager"
const manPath = join(root, "cs.1");
const man = readFileSync(manPath, "utf-8");
const TH_RE = /^\.TH CS 1 "([^"]*)" "cs ([^"]*)"/m;
const manMatch = man.match(TH_RE);
if (!manMatch) {
  console.error("Could not find the .TH header in cs.1");
  process.exit(1);
}
const manVersion = manMatch[2];

const drift: string[] = [];
if (libVersion !== version) drift.push(`lib.ts (${String(libVersion)})`);
if (pkgVersion !== version) drift.push(`package.json (${String(pkgVersion)})`);
if (manVersion !== version) drift.push(`cs.1 (${String(manVersion)})`);

if (check) {
  if (drift.length) {
    console.error(`Version drift vs VERSION (${version}): ${drift.join(", ")}`);
    process.exit(1);
  }
  console.log(`Version OK: ${version}`);
  process.exit(0);
}

if (libVersion !== version) {
  writeFileSync(
    libPath,
    lib.replace(/export const VERSION = "[^"]*";/, `export const VERSION = "${version}";`)
  );
}
if (pkgVersion !== version) {
  pkg["version"] = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}
// Only rewritten when the version actually changes, so the .TH date means "date
// of this release" and a rebuild on an unchanged tree stays a no-op.
if (manVersion !== version) {
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    manPath,
    man.replace(TH_RE, `.TH CS 1 "${today}" "cs ${version}"`)
  );
}
console.log(drift.length ? `Version synced to ${version} (${drift.join(", ")})` : `Version already ${version}`);
