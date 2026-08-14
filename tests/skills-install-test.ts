/**
 * Verifies the two inherited installer bugs are actually fixed:
 *  - no ${CLAUDE_PLUGIN_ROOT} or __TYPEGRAPH_* placeholder survives to disk
 *  - the generated health command remains executable after the project moves
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
import { execSync } from "node:child_process";
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
import type { SkillsDir } from "../src/agents.ts";

const sourceDir = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-skills-"));
// Stand in for a real dependency install: the package the skills must invoke
// is not the same directory the skills are written to.
const packageRoot = path.join(tmp, "node_modules", "typegraph-mcp");
fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(packageRoot, "dist/cli.cjs"),
  'require("node:fs").writeFileSync("health-check.json", JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\n',
);

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
// Simulate Git for Windows checking out the template with CRLF. Parsing the
// copied command must not leak a carriage return into the final CLI argument.
fs.writeFileSync(
  codexCopy,
  fs.readFileSync(codexCopy, "utf8").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"),
);
const prereq = fs
  .readFileSync(codexCopy, "utf8")
  .split(/\r?\n/)
  .find((l) => l.includes("typegraph-mcp") && l.includes("check"));
console.log(`\ndeep-survey prerequisite as installed for Codex:\n  ${prereq}`);

assert.ok(prereq, "prerequisite command line should exist");
assert.ok(
  prereq.includes('node "./node_modules/typegraph-mcp/dist/cli.cjs" check'),
  "project dependency health check must use the portable public CLI",
);
assert.ok(!prereq.startsWith('"node"'), "PowerShell requires a bare command name unless `&` is used");
assert.ok(!prereq.includes(tmp), "project dependency check must survive relocating the project");
assert.ok(
  prereq.includes('--project-root "."'),
  "health check must explicitly target the consumer project",
);
assert.ok(
  prereq.includes('--tsconfig "./tsconfig.typegraph.json"'),
  "health check must use the configured tsconfig",
);

const moved = `${tmp} moved`;
fs.renameSync(tmp, moved);
execSync(prereq, { cwd: moved, stdio: "pipe" });
const health = JSON.parse(fs.readFileSync(path.join(moved, "health-check.json"), "utf-8"));
assert.equal(fs.realpathSync(health.cwd), fs.realpathSync(moved));
assert.deepEqual(health.argv, [
  "check",
  "--project-root",
  ".",
  "--tsconfig",
  "./tsconfig.typegraph.json",
]);
console.log("  ok  generated command executes after relocating the project");

const attributes = fs.readFileSync(path.join(sourceDir, ".gitattributes"), "utf-8");
assert.ok(attributes.includes("* text=auto eol=lf"));
console.log("  ok  repository checkout pins generated text to LF");

fs.rmSync(moved, { recursive: true, force: true });

if (leaks.length > 0) {
  console.error(`\nFAIL: ${leaks.length} unexpanded placeholders`);
  for (const l of leaks) console.error(`  ${l}`);
  process.exit(1);
}
console.log("\nOK: no unexpanded placeholders, relocated health command works");
