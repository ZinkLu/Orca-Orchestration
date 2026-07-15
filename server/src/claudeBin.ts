import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cached: string | null | undefined;

/**
 * Locate the installed `claude` native CLI so the Agent SDK can spawn it.
 *
 * When this server runs from a `bun build --compile` binary, the SDK can't
 * resolve its own bundled native CLI: that binary lives in a sibling
 * optional-dependency package (`@anthropic-ai/claude-agent-sdk-<platform>`)
 * resolved via `createRequire(import.meta.url)`, and that package isn't on disk
 * next to a standalone binary. So we must hand the SDK an explicit
 * `pathToClaudeCodeExecutable`. The machine already needs a logged-in `claude`
 * for the subscription auth, so PATH is the natural, always-present source.
 *
 * Returns `undefined` when nothing is found — in a dev checkout (with
 * node_modules) the SDK's own resolver still works, so we don't force a path.
 */
export function resolveClaudeExecutable(): string | undefined {
  if (cached !== undefined) return cached ?? undefined;
  cached = probe();
  return cached ?? undefined;
}

function probe(): string | null {
  const override = process.env.CLAUDE_CLI_PATH;
  if (override && existsSync(override)) return override;

  // Bun.which honors the current PATH and is fastest when available.
  const bunWhich = (globalThis as { Bun?: { which?: (c: string) => string | null } }).Bun?.which?.(
    "claude",
  );
  if (bunWhich && existsSync(bunWhich)) return bunWhich;

  // A login shell picks up PATH entries (~/.local/bin, brew) even when the
  // binary was launched from a GUI with a minimal environment.
  for (const cmd of ["command -v claude", "which claude"]) {
    try {
      const p = execFileSync("/bin/sh", ["-lc", cmd], { encoding: "utf8" }).trim();
      if (p && existsSync(p)) return p;
    } catch {
      // try the next strategy
    }
  }

  for (const candidate of [
    join(homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
