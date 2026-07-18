#!/usr/bin/env bun
// Emit cs.bundle.js.sha256 next to the built bundle so `cs update` and
// install-remote.sh can verify the download before overwriting the running
// binary. Runs as the last step of `bun run build`.
//
//   bun scripts/checksum.ts           # write cs.bundle.js.sha256
//   bun scripts/checksum.ts --check   # verify the recorded digest, no writes
import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const check = process.argv.includes("--check");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(root, "cs.bundle.js");
const sumPath = join(root, "cs.bundle.js.sha256");

const hex = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");

if (check) {
  const recorded = readFileSync(sumPath, "utf-8").trim().split(/\s+/)[0] ?? "";
  if (recorded !== hex) {
    console.error(`Checksum drift: cs.bundle.js.sha256 records ${recorded}, bundle is ${hex}`);
    process.exit(1);
  }
  console.log(`Checksum OK: ${hex.slice(0, 12)}…`);
  process.exit(0);
}

// sha256sum-compatible line so users can also run `sha256sum -c cs.bundle.js.sha256`.
writeFileSync(sumPath, `${hex}  cs.bundle.js\n`);
console.log(`Wrote cs.bundle.js.sha256 (${hex.slice(0, 12)}…)`);
