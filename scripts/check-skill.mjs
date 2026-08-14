#!/usr/bin/env node
// Validate skill/SKILL.md so a bad edit can't silently break distribution.
//
// `npx skills add ZinkLu/Orca-Orchestration --skill orca-dag` is the install
// path for the skill half of this project. The skills CLI discovers the skill
// by walking the repo for SKILL.md and reads its *frontmatter* for the name and
// the description the agent matches against — a dropped `---` fence or a
// renamed `name:` changes the install command out from under every user, and
// nothing else in the build would notice.
//
// Deliberately hand-rolled instead of shelling out to `npx skills add . --list`:
// that command prompts when it detects no coding agent, which would hang CI.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "skill", "SKILL.md");
const EXPECTED_NAME = "orca-dag";

const text = readFileSync(path, "utf8");
const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
if (!match) {
  console.error(`skill/SKILL.md: missing YAML frontmatter (must open with a --- fence on line 1)`);
  process.exit(1);
}

const body = match[1];
const errors = [];
const name = /^name:\s*(.+)$/m.exec(body)?.[1]?.trim().replace(/^["']|["']$/g, "");
const description = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim().replace(/^["']|["']$/g, "");

if (name !== EXPECTED_NAME) {
  errors.push(`name must stay "${EXPECTED_NAME}" (the documented install command hardcodes it), got ${name ?? "nothing"}`);
}
if (!description) {
  errors.push("description is required — it is the only thing an agent sees when deciding to load the skill");
} else if (description.length < 40) {
  errors.push(`description is ${description.length} chars; too terse to route on (want a "use when …" sentence)`);
}
if (text.slice(match[0].length).trim().length < 500) {
  errors.push("body is nearly empty — the skill teaches the whole orca orchestration workflow");
}

if (errors.length) {
  for (const e of errors) console.error(`skill/SKILL.md: ${e}`);
  process.exit(1);
}

console.log(`✅ skill/SKILL.md ok — installable as \`npx skills add ZinkLu/Orca-Orchestration --skill ${name}\``);
