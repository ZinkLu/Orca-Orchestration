#!/usr/bin/env node
// Cut a release.
//
//   npm run release 0.2.0
//
// That is the whole publishing procedure. The tag is the version of record:
// pushing `v0.2.0` triggers .github/workflows/release.yml, which publishes the
// `orca-dag` npm package and attaches a binary for every platform to a GitHub
// release. Nothing in the repo needs a version bump commit.
//
// The checks below exist because the tag is irreversible in practice — once
// `npm publish` runs, that version number is burned even if you unpublish.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const raw = process.argv[2];
if (!raw) {
  console.error("Usage: npm run release <version>      e.g. npm run release 0.2.0");
  process.exit(1);
}
const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`"${raw}" is not a semver version (expected e.g. 0.2.0 or 1.0.0-rc.1)`);
  process.exit(1);
}
const tag = `v${version}`;

if (git("status", "--porcelain")) {
  console.error("Working tree is dirty — commit or stash first; the tag must point at a reviewed commit.");
  process.exit(1);
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") {
  console.error(`On branch "${branch}". Releases are cut from main.`);
  process.exit(1);
}

const tags = git("tag", "--list").split("\n").filter(Boolean);
if (tags.includes(tag)) {
  console.error(`Tag ${tag} already exists. Versions are immutable on npm — pick the next one.`);
  process.exit(1);
}

// Fail here rather than in CI: a typecheck error would otherwise surface after
// the tag is already public.
console.log("Checking the tree builds…");
execFileSync("node", [join(root, "scripts", "check-skill.mjs")], { cwd: root, stdio: "inherit" });
execFileSync("npx", ["tsc", "-p", "server/tsconfig.json", "--noEmit"], { cwd: root, stdio: "inherit" });
execFileSync("node", [join(root, "scripts", "build-npm.mjs")], { cwd: root, stdio: "inherit" });

git("tag", "-a", tag, "-m", `Release ${tag}`);
execFileSync("git", ["push", "origin", tag], { cwd: root, stdio: "inherit" });

const remote = git("remote", "get-url", "origin").replace(/\.git$/, "");
console.log(`\n✅ Pushed ${tag}. CI is now publishing:`);
console.log(`   npm      → https://www.npmjs.com/package/orca-dag/v/${version}`);
console.log(`   binaries → ${remote}/releases/tag/${tag}`);
console.log(`   progress → ${remote}/actions`);
