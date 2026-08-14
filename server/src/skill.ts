// Install `skill/SKILL.md` into the coding agents on this machine.
//
// Why the viewer does this at all: the project has two halves that are useless
// apart — the skill teaches your agent to *build* the DAG, the viewer *runs* it
// — and making people install them separately is one step too many. So
// `npx orca-dag` installs the skill on startup and then serves the UI. One
// command, everything works.
//
// It is deliberately dumb and idempotent: write the file, don't touch anything
// else. No symlinks (they break when the npx cache is evicted), no agent config
// edits, no network. Opt out with `--no-skill` / `ORCA_DAG_NO_SKILL=1`.

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadEmbeddedSkill } from "./webAssets";

export const SKILL_NAME = "orca-dag";

/**
 * Where each agent looks for globally-installed skills.
 *
 * Paths taken from the `skills` CLI's own table (the community installer Orca
 * shells out to), so a skill dropped here is found by the same agents that
 * `npx skills add` would target. We only write into an agent's directory when
 * its *parent* config dir already exists — otherwise installing would litter a
 * host with config folders for agents it doesn't have.
 */
export const AGENT_SKILL_DIRS: Array<{ agent: string; parent: string; skills: string }> = [
  { agent: "Claude Code", parent: ".claude", skills: ".claude/skills" },
  { agent: "Codex", parent: ".codex", skills: ".codex/skills" },
  { agent: "Cursor", parent: ".cursor", skills: ".cursor/skills" },
  { agent: "OpenCode", parent: ".config/opencode", skills: ".config/opencode/skills" },
  { agent: "Gemini CLI", parent: ".gemini", skills: ".gemini/skills" },
  { agent: "Droid", parent: ".factory", skills: ".factory/skills" },
  // Shared directory read by Amp, Cline, Warp, Zed and friends.
  { agent: "universal", parent: ".agents", skills: ".agents/skills" },
];

/**
 * Find the skill text: embedded in the binary, or on disk.
 *
 * Disk candidates cover the npm package (`<pkg>/skill/SKILL.md`, two levels up
 * from `<pkg>/dist/server/`) and a dev checkout (`<repo>/skill/SKILL.md`, two
 * levels up from `<repo>/server/src/`) — which happen to be the same relative
 * path, the same coincidence the web/dist fallback relies on.
 */
async function readSkill(here: string): Promise<string | null> {
  const embedded = await loadEmbeddedSkill();
  if (embedded) return embedded;
  for (const candidate of [join(here, "..", "..", "skill", "SKILL.md"), join(here, "..", "..", "..", "skill", "SKILL.md")]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return null;
}

export interface SkillInstallResult {
  installed: string[];
  upToDate: string[];
  skipped: "disabled" | "not-found" | null;
}

/**
 * Write the skill into every agent present on this machine.
 *
 * Never throws: a read-only home directory or a weird agent layout must not
 * stop the viewer from starting — the skill is a convenience, the UI is the
 * product.
 */
export async function installSkill(moduleDir: string, enabled: boolean): Promise<SkillInstallResult> {
  const result: SkillInstallResult = { installed: [], upToDate: [], skipped: null };
  if (!enabled) {
    result.skipped = "disabled";
    return result;
  }

  const text = await readSkill(moduleDir);
  if (!text) {
    result.skipped = "not-found";
    return result;
  }

  const home = homedir();
  for (const { parent, skills } of AGENT_SKILL_DIRS) {
    if (!existsSync(join(home, parent))) continue;
    const dir = join(home, skills, SKILL_NAME);
    const target = join(dir, "SKILL.md");
    try {
      // A symlinked skill directory is someone pointing at their own checkout
      // (the `ln -s "$PWD/skill"` recipe in the README). Writing would follow
      // the link and clobber their working copy — leave it alone entirely.
      if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
        result.upToDate.push(target);
        continue;
      }
      // Rewriting only on change keeps the log quiet on every restart and keeps
      // mtimes stable for agents that cache their skill index.
      if (existsSync(target) && readFileSync(target, "utf8") === text) {
        result.upToDate.push(target);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      result.installed.push(target);
    } catch {
      // Unwritable directory — skip this agent silently.
    }
  }
  return result;
}

/** One-line startup summary; returns null when there is nothing worth saying. */
export function describeSkillInstall(result: SkillInstallResult): string | null {
  if (result.skipped === "not-found") return `Skill "${SKILL_NAME}" not found in this install — skipped.`;
  if (result.skipped) return null;
  if (result.installed.length > 0) {
    return `Skill "${SKILL_NAME}" installed for ${result.installed.length} agent(s): ${result.installed
      .map((p) => p.replace(homedir(), "~"))
      .join(", ")}`;
  }
  if (result.upToDate.length > 0) return `Skill "${SKILL_NAME}" already up to date (${result.upToDate.length} agent(s)).`;
  return `No coding agent found to install the skill "${SKILL_NAME}" into — see the README to place it by hand.`;
}
