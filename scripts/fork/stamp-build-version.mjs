#!/usr/bin/env node
// Fork release builds: stamp apps/server/package.json with the version this
// tree actually represents, so provider-compatibility policies classify the
// build correctly (upstream CI does this for nightlies; source builds must do
// it themselves).
//
//   node scripts/fork/stamp-build-version.mjs            # stamp and print
//   node scripts/fork/stamp-build-version.mjs --restore  # restore original bytes
//   node scripts/fork/stamp-build-version.mjs -- <cmd>   # stamp, run cmd, restore (even on failure)
//
// Stamped version = max(package version, manifest t3CodeRange lower bounds,
// installed runtime nightly bases) + "-dev.<shortsha>". The semver range
// checker ignores prerelease suffixes, so 0.0.46-dev.abc counts as 0.0.46.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const pkgPath = join(repoRoot, "apps/server/package.json");
const manifestPath = join(repoRoot, "apps/server/src/provider/model-manifest.json");
const backupPath = join(repoRoot, "scripts/fork/.version-backup");
const runtimeVersionsDir = join(process.env.HOME ?? "", ".t3/runtime/versions");

const parseVersion = (text) => {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.].*)?$/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
};

const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const maxVersion = (candidates) => {
  const parsed = candidates.filter(Boolean).map(parseVersion).filter(Boolean);
  return parsed.sort(compareVersions).at(-1)?.join(".") ?? null;
};

const candidates = [JSON.parse(readFileSync(pkgPath, "utf8")).version];

// Lower bounds the tree itself declares (e.g. ">=0.0.46" opencode policy).
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const policy of manifest.compatibility ?? []) {
    for (const match of policy.t3CodeRange?.matchAll(/(?:^|\s)>=(\d+(?:\.\d+){0,2})/g) ?? []) {
      candidates.push(match[1]);
    }
  }
}

// Official nightlies installed locally prove the current release cycle target.
if (existsSync(runtimeVersionsDir)) {
  for (const entry of readdirSync(runtimeVersionsDir)) {
    const base = entry.split("-")[0];
    if (/^\d+\.\d+\.\d+$/.test(base)) candidates.push(base);
  }
}

const next = maxVersion(candidates);
if (!next) {
  console.error("stamp-build-version: could not determine a version");
  process.exit(1);
}

const shortSha = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot })
      .toString()
      .trim();
  } catch {
    return "local";
  }
})();

const stamp = () => {
  if (existsSync(backupPath)) {
    console.error("stamp-build-version: already stamped; run --restore first");
    process.exit(1);
  }
  const original = readFileSync(pkgPath);
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, original);
  const stamped = readFileSync(pkgPath, "utf8").replace(
    /^(\s*)"version": "[^"]*"/m,
    `$1"version": "${next}-dev.${shortSha}"`,
  );
  writeFileSync(pkgPath, stamped);
  console.log(`stamp-build-version: ${next}-dev.${shortSha}`);
};

const restore = () => {
  if (!existsSync(backupPath)) return false;
  writeFileSync(pkgPath, readFileSync(backupPath));
  rmSync(backupPath);
  return true;
};

const args = process.argv.slice(2);
if (args[0] === "--restore") {
  process.exit(restore() ? 0 : (console.error("stamp-build-version: nothing to restore"), 1));
}

if (args[0] === "--") {
  const command = args.slice(1);
  if (command.length === 0) {
    console.error("stamp-build-version: no command after --");
    process.exit(1);
  }
  stamp();
  let status = 0;
  try {
    const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", cwd: repoRoot });
    status = result.status ?? (result.error ? 1 : 0);
  } finally {
    restore();
  }
  process.exit(status);
} else {
  stamp();
}
