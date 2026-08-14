#!/usr/bin/env node
// Stage the publishable npm package for the Orca DAG viewer.
//
//   node scripts/build-npm.mjs        → dist-npm/  (then `npm publish dist-npm`)
//
// Why a staging directory instead of publishing a workspace package:
// the repo root is a private npm-workspaces root (`server` + `web` are both
// private), so nothing here is publishable as-is. We assemble a third,
// dependency-free tree instead — esbuild inlines express/cors, so the tarball
// is one file plus the SPA and `npx orca-dag` costs a single download.
//
// Layout (the "../../web/dist" fallback in server/src/index.ts is what dictates
// where the bundle goes — keep dist/server/index.mjs at exactly that depth):
//
//   dist-npm/
//     package.json
//     bin/orca-dag.mjs      ← shebang shim, the `bin` entry
//     dist/server/index.mjs ← esbuild bundle (__dirname/../../web/dist resolves inside the package)
//     web/dist/**           ← vite output, served from disk (no base64 embedding needed)
//     README.md, README_zh.md, LICENSE, skill/SKILL.md
//
// Unlike `build-binary.mjs` this needs no Bun: the server only touches express,
// cors and node: builtins, so a plain Node bundle runs everywhere `npx` does.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-npm");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// The published version comes from the git tag in CI (v1.2.3 → 1.2.3) and falls
// back to the root package.json for local `npm pack` smoke tests.
const version = (process.env.PKG_VERSION ?? rootPkg.version).replace(/^v/, "");

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
}

// 1. Build the SPA ----------------------------------------------------------
run("npm", ["run", "build", "-w", "web"]);
const webDist = join(root, "web", "dist");
if (!existsSync(webDist)) throw new Error(`vite build produced no ${webDist}`);

// 2. Bundle the server ------------------------------------------------------
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist", "server"), { recursive: true });

// `./generated/webAssets` only exists during a Bun binary build; the npm package
// serves web/dist from disk instead, so mark it external and let the dynamic
// import fail at runtime exactly as it does in a dev checkout.
run(join(root, "node_modules", ".bin", "esbuild"), [
  "server/src/index.ts",
  "--bundle",
  "--platform=node",
  "--target=node20",
  "--format=esm",
  "--legal-comments=none",
  "--external:./generated/webAssets",
  // express reaches for `require` in a few CJS corners; ESM output has none.
  `--banner:js=import{createRequire as __cr}from "node:module";const require=__cr(import.meta.url);`,
  `--outfile=${join(out, "dist", "server", "index.mjs")}`,
]);

// 3. Assemble the package tree ---------------------------------------------
mkdirSync(join(out, "bin"), { recursive: true });
writeFileSync(
  join(out, "bin", "orca-dag.mjs"),
  `#!/usr/bin/env node\n// Thin launcher: the real server lives two levels down so its\n// "../../web/dist" asset lookup lands inside this package.\nimport "../dist/server/index.mjs";\n`,
  { mode: 0o755 },
);

mkdirSync(join(out, "web"), { recursive: true });
cpSync(webDist, join(out, "web", "dist"), { recursive: true });
for (const f of ["README.md", "README_zh.md", "LICENSE"]) {
  if (existsSync(join(root, f))) cpSync(join(root, f), join(out, f));
}
// Ship the skill too, so `npx skills add orca-dag` (npm source) and a plain
// `npm i -g orca-dag` both put SKILL.md on disk next to the viewer.
mkdirSync(join(out, "skill"), { recursive: true });
cpSync(join(root, "skill", "SKILL.md"), join(out, "skill", "SKILL.md"));

writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "orca-dag",
      version,
      description: rootPkg.description,
      type: "module",
      bin: { "orca-dag": "bin/orca-dag.mjs" },
      files: ["bin", "dist", "web", "skill", "README.md", "README_zh.md", "LICENSE"],
      engines: { node: ">=20" },
      keywords: ["orca", "orchestration", "dag", "agents", "coordinator", "react-flow"],
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/ZinkLu/Orca-Orchestration.git" },
      homepage: "https://github.com/ZinkLu/Orca-Orchestration#readme",
      bugs: { url: "https://github.com/ZinkLu/Orca-Orchestration/issues" },
      // No dependencies on purpose — express and cors are inlined by esbuild.
    },
    null,
    2,
  ) + "\n",
);

console.log(`\n✅ Staged npm package → dist-npm (version ${version})`);
console.log(`   Smoke test:  node dist-npm/bin/orca-dag.mjs`);
console.log(`   Publish:     npm publish dist-npm --access public`);
