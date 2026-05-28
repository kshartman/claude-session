#!/usr/bin/env bun
// Single-source the version. The VERSION file is canonical; this script copies
// it into the embedded constant in lib.ts and the "version" field in
// package.json so a release is just "edit VERSION, run build".
//
//   bun scripts/sync-version.ts           # rewrite lib.ts + package.json to match VERSION
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

const drift: string[] = [];
if (libVersion !== version) drift.push(`lib.ts (${String(libVersion)})`);
if (pkgVersion !== version) drift.push(`package.json (${String(pkgVersion)})`);

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
console.log(drift.length ? `Version synced to ${version} (${drift.join(", ")})` : `Version already ${version}`);
