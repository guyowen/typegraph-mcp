/**
 * Verifies the two inherited installer bugs are actually fixed:
 *  - no ${CLAUDE_PLUGIN_ROOT} or __TYPEGRAPH_* placeholder survives to disk
 *  - the interpreter written is not a version-pinned nvm or fnm path
 *
 * The placeholder half matters more now than it did under the plugin layout:
 * skills are installed into directories the agent owns, and the package they
 * need to invoke lives somewhere else entirely, so an unexpanded token is not
 * recoverable from context.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHECK_PLACEHOLDER,
  CLI_PLACEHOLDER,
  installSkills,
  skillsDirFor,
  LEGACY_PLACEHOLDERS,
  NODE_PLACEHOLDER,
  ROOT_PLACEHOLDER,
  SKILL_NAMES,
  TSCONFIG_PLACEHOLDER,
} from "../src/install-skills.ts";
import { resolveInterpreter } from "../src/install-paths.ts";
import type { SkillsDir } from "../src/agents.ts";

const sourceDir = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-skills-"));
// Stand in for a real dependency install: the package the skills must invoke
// is not the same directory the skills are written to.
const packageRoot = path.join(tmp, "node_modules", "typegraph-mcp");
fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
fs.writeFileSync(path.join(packageRoot, "dist/cli.cjs"), "// stand-in\n");

const res = installSkills({
  sourceDir,
  projectRoot: tmp,
  packageRoot,
  tsconfig: "./tsconfig.typegraph.json",
  selectedAgents: ["claude-code", "codex", "opencode"],
});

console.log(`targets: ${res.targets.join(", ")}`);
for (const [k, v] of Object.entries(res.byTarget)) {
  console.log(`  ${k}: ${v.dir.replace(tmp, "<proj>")} agents=[${v.agents.join(", ")}] written=${v.written}`);
}

const FORBIDDEN = [
  ROOT_PLACEHOLDER,
  NODE_PLACEHOLDER,
  CHECK_PLACEHOLDER,
  CLI_PLACEHOLDER,
  TSCONFIG_PLACEHOLDER,
  ...LEGACY_PLACEHOLDERS,
];
const leaks: string[] = [];

for (const target of res.targets as SkillsDir[]) {
  const root = skillsDirFor(tmp, target);
  for (const skill of SKILL_NAMES) {
    const f = path.join(root, skill, "SKILL.md");
    if (!fs.existsSync(f)) continue;
    const content = fs.readFileSync(f, "utf8");
    for (const token of FORBIDDEN) {
      if (content.includes(token)) leaks.push(`${target}/${skill}: ${token}`);
    }
  }
}

const codexCopy = path.join(tmp, ".agents/skills/deep-survey/SKILL.md");
assert.ok(fs.existsSync(codexCopy), "codex should receive deep-survey via .agents/skills");
const prereq = fs
  .readFileSync(codexCopy, "utf8")
  .split("\n")
  .find((l) => l.includes("typegraph-mcp") && l.includes("check"));
console.log(`\ndeep-survey prerequisite as installed for Codex:\n  ${prereq}`);

assert.ok(prereq, "prerequisite command line should exist");
assert.ok(
  prereq.includes('"node" "./node_modules/typegraph-mcp/dist/cli.cjs" check'),
  "project dependency health check must use the portable public CLI",
);
assert.ok(!prereq.includes(tmp), "project dependency check must survive relocating the project");
assert.ok(
  prereq.includes('--project-root "."'),
  "health check must explicitly target the consumer project",
);
assert.ok(
  prereq.includes('--tsconfig "./tsconfig.typegraph.json"'),
  "health check must use the configured tsconfig",
);

const interp = resolveInterpreter();
console.log(`\ninterpreter: ${interp.command} (stable=${interp.stable})`);
assert.ok(
  !/\/\.nvm\/versions\/node\/v[^/]+\/bin\/node$/.test(interp.command),
  `interpreter must not be a version-pinned nvm path: ${interp.command}`,
);
assert.ok(
  !/\/fnm\/node-versions\/v[^/]+\/installation\/bin\/node$/.test(interp.command),
  `interpreter must not be a version-pinned fnm path: ${interp.command}`,
);

fs.rmSync(tmp, { recursive: true, force: true });

if (leaks.length > 0) {
  console.error(`\nFAIL: ${leaks.length} unexpanded placeholders`);
  for (const l of leaks) console.error(`  ${l}`);
  process.exit(1);
}
console.log("\nOK: no unexpanded placeholders, interpreter is upgrade-safe");
