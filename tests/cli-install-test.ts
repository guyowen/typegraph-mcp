/**
 * Full installer round-trip in a throwaway project.
 *
 * Two things this is watching for:
 *
 *  - Nothing is copied into the project except SKILL.md files. The plugin
 *    directory is gone, so a stray `plugins/` write is a regression.
 *  - The server path baked into each config. A project-scoped config is
 *    normally committed, so it must carry a project-relative path whenever the
 *    package is a real dependency — an absolute one resolves only on the
 *    machine that ran setup.
 *
 * It also deliberately seeds an `opencode.jsonc` WITH comments and a `//`
 * inside a string, because that is the case the inherited installer would have
 * silently skipped (JSON.parse throws -> warn -> no MCP registration).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "src/cli.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cli-"));

// ─── seed a project ──────────────────────────────────────────────────────────
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.mkdirSync(path.join(tmp, ".cursor"), { recursive: true });
fs.writeFileSync(path.join(tmp, "src/index.ts"), "export const hello = 1;\n");
fs.writeFileSync(path.join(tmp, "tsconfig.json"), JSON.stringify({ include: ["src"] }, null, 2));
fs.writeFileSync(path.join(tmp, "CLAUDE.md"), "# Project\n");
fs.writeFileSync(path.join(tmp, "AGENTS.md"), "# Agents\n");
fs.writeFileSync(
  path.join(tmp, "opencode.jsonc"),
  `{
  // OpenCode config with comments — JSON.parse would throw here
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-5", // trailing comment
  "instructions": ["see https://example.com//docs"],
  "mcp": {
    "typegraph": { "type": "local", "command": ["node", "legacy-server.js"] }
  }
}
`,
);

// HOME is redirected because upgrade cleanup removes stale global config from
// older releases; the suite must not reach the developer's real files.
const fakeHome = path.join(tmp, "home");
fs.mkdirSync(fakeHome, { recursive: true });

// Simulate the first-generation plugin installer so setup can prove it performs
// upgrade cleanup, not just clean-project installation.
fs.mkdirSync(path.join(tmp, "plugins/typegraph-mcp/src"), { recursive: true });
fs.writeFileSync(path.join(tmp, "plugins/typegraph-mcp/src/server.ts"), "// legacy plugin server\n");
fs.appendFileSync(path.join(tmp, "CLAUDE.md"), "Load with: claude --plugin-dir ./plugins/typegraph-mcp\n");
fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, ".claude/mcp.json"),
  JSON.stringify(
    {
      mcpServers: {
        typegraph: { command: "node", args: [path.join(tmp, "plugins/typegraph-mcp/src/server.ts")] },
        keep: { command: "node", args: ["keep.js"] },
      },
    },
    null,
    2,
  ) + "\n",
);
fs.mkdirSync(path.join(tmp, ".cursor/skills/tool-selection"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, ".cursor/skills/tool-selection/SKILL.md"),
  "legacy skill using ${CLAUDE_PLUGIN_ROOT}\n",
);
fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
fs.writeFileSync(
  path.join(fakeHome, ".codex/config.toml"),
  [
    "[mcp_servers.typegraph]",
    `command = "node"`,
    `args = ["${path.join(tmp, "plugins/typegraph-mcp/src/server.ts")}"]`,
    "",
    "[mcp_servers.keep]",
    `command = "node"`,
    `args = ["keep.js"]`,
    "",
  ].join("\n"),
);

// The PROJECT Codex config gets the same hand-rolled table, and this is the one
// that bit: no sentinels to find, so setup appended a second
// [mcp_servers.typegraph] and TOML's duplicate-key rule stopped Codex from
// parsing its config at all. The `other` table below must survive the rewrite,
// and the tools subtable must migrate with the server name.
fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, ".codex/config.toml"),
  [
    "[mcp_servers.typegraph]",
    `command = "tsx"`,
    `args = ["plugins/typegraph-mcp/server.ts"]`,
    "",
    "[mcp_servers.typegraph.tools.ts_find_symbol]",
    `approval_mode = "auto"`,
    "",
    "[mcp_servers.other]",
    `command = "python3"`,
    `args = ["other.py"]`,
    "",
  ].join("\n"),
);

const run = (...args: string[]): string =>
  execFileSync(process.execPath, [cli, ...args], {
    cwd: tmp,
    env: { ...process.env, HOME: fakeHome, TYPEGRAPH_PROJECT_ROOT: tmp },
    encoding: "utf-8",
  });

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const readJson = (rel: string): any => JSON.parse(fs.readFileSync(path.join(tmp, rel), "utf-8"));

console.log("setup --yes (detects claude-code, cursor, codex, opencode)");
run("setup", "--yes");

console.log("\nno plugin directory");
check("legacy plugins/ removed", !fs.existsSync(path.join(tmp, "plugins")));
check(
  "no copy of the server in the project",
  !fs.existsSync(path.join(tmp, "plugins/typegraph-mcp/src/server.ts")),
);
check(
  "legacy Claude --plugin-dir entry removed",
  !fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf-8").includes("--plugin-dir ./plugins/typegraph-mcp"),
);
const legacyClaudeMcp = readJson(".claude/mcp.json");
check("legacy .claude/mcp.json entry removed", !legacyClaudeMcp.mcpServers?.typegraph);
check("unrelated .claude/mcp.json entry preserved", !!legacyClaudeMcp.mcpServers?.keep);
const globalCodex = fs.readFileSync(path.join(fakeHome, ".codex/config.toml"), "utf-8");
check("stale global Codex typegraph entry removed", !globalCodex.includes("[mcp_servers.typegraph]"));
check("unrelated global Codex entry preserved", globalCodex.includes("[mcp_servers.keep]"));

console.log("\nskills routing");
check(
  ".claude/skills written (Claude Code + Cursor + OpenCode)",
  fs.existsSync(path.join(tmp, ".claude/skills/tool-selection/SKILL.md")),
);
check(
  ".agents/skills written (Codex)",
  fs.existsSync(path.join(tmp, ".agents/skills/tool-selection/SKILL.md")),
);
check(
  ".cursor/skills NOT written — Cursor rides along with .claude/skills",
  !fs.existsSync(path.join(tmp, ".cursor/skills")),
);

const claudeSkill = fs.readFileSync(path.join(tmp, ".claude/skills/deep-survey/SKILL.md"), "utf-8");
check(
  "no unexpanded placeholder",
  !claudeSkill.includes("__TYPEGRAPH_") && !claudeSkill.includes("${CLAUDE_PLUGIN_ROOT}"),
);
check("skill points at the real package root", claudeSkill.includes(repoRoot));

console.log("\nMCP registration");
const mcp = readJson(".mcp.json");
const mcpServer = mcp.mcpServers?.["typegraph-mcp"];
check("project .mcp.json written as typegraph-mcp (Claude Code)", !!mcpServer);
check("legacy project server name absent", !mcp.mcpServers?.typegraph);
check(
  "not a plugin .mcp.json",
  !fs.existsSync(path.join(tmp, "plugins/typegraph-mcp/.mcp.json")),
);
check(
  "server path is absolute while the package is not a dependency",
  path.isAbsolute(mcpServer?.args?.[0] ?? ""),
  mcpServer?.args?.[0],
);
check(
  "server path exists on disk",
  fs.existsSync(path.resolve(tmp, mcpServer.args[0])),
);

const cursor = readJson(".cursor/mcp.json");
check("cursor mcp.json written", !!cursor.mcpServers?.["typegraph-mcp"]);

const oc = readJson("opencode.jsonc");
const ocServer = oc.mcp?.["typegraph-mcp"];
check("opencode.jsonc parsed despite comments", !!ocServer, "entry present");
check("legacy OpenCode server name removed", !oc.mcp?.typegraph);
check("opencode entry uses type:local", ocServer?.type === "local", ocServer?.type);
check(
  "opencode command is ONE array",
  Array.isArray(ocServer?.command) && ocServer.command.length === 2,
  JSON.stringify(ocServer?.command),
);
check(
  "no tsx in the invocation (plain node trampoline)",
  !JSON.stringify(ocServer?.command).includes("tsx"),
);
check("existing user config preserved", oc.model === "anthropic/claude-sonnet-5", oc.model);
check(
  "string containing // not corrupted",
  oc.instructions?.[0] === "see https://example.com//docs",
  oc.instructions?.[0],
);

const toml = fs.readFileSync(path.join(tmp, ".codex/config.toml"), "utf-8");
check("codex toml block written", toml.includes("[mcp_servers.typegraph-mcp]"));
check("legacy Codex server name absent", !toml.includes("[mcp_servers.typegraph]"));
const tableCount = (s: string, header: string): number => s.split(`\n${header}`).length - 1;
check(
  "hand-rolled table adopted, not duplicated (TOML duplicate key)",
  tableCount(`\n${toml}`, "[mcp_servers.typegraph-mcp]") === 1,
  `${tableCount(`\n${toml}`, "[mcp_servers.typegraph-mcp]")} occurrences`,
);
check("adopted table is now sentinel-wrapped", toml.includes("# >>> typegraph-mcp >>>"));
check("stale legacy server path gone", !toml.includes("plugins/typegraph-mcp/server.ts"));
check("unrelated project Codex entry preserved", toml.includes("[mcp_servers.other]"));
check(
  "typegraph-mcp subtable migrated",
  toml.includes("[mcp_servers.typegraph-mcp.tools.ts_find_symbol]"),
);

console.log("\nagent instruction files");
const claudeMd = fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf-8");
const agentsMd = fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf-8");
check("CLAUDE.md snippet", claudeMd.includes("TypeScript Navigation"));
check("AGENTS.md snippet", agentsMd.includes("TypeScript Navigation"));
check("AGENTS.md prefers TypeGraph before grep", agentsMd.includes("before `rg`/`grep`"));
check("AGENTS.md mentions LSP hover", agentsMd.includes("`ts_hover`"));
check("AGENTS.md mentions Effect diagnostics", agentsMd.includes("`ts_effect_diagnostics`"));
check("AGENTS.md mentions code actions", agentsMd.includes("`ts_code_actions`"));

console.log("\nlegacy sentinel migration");
const codexPath = path.join(tmp, ".codex/config.toml");
fs.writeFileSync(
  codexPath,
  fs.readFileSync(codexPath, "utf-8").replaceAll("mcp_servers.typegraph-mcp", "mcp_servers.typegraph"),
);
run("setup", "--yes");
const migratedToml = fs.readFileSync(codexPath, "utf-8");
check("current legacy block is persisted under the new name", migratedToml.includes("[mcp_servers.typegraph-mcp]"));
check("current legacy block is removed", !migratedToml.includes("[mcp_servers.typegraph]"));

console.log("\nidempotence");
const before = fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf-8");
run("setup", "--yes");
check("re-running setup does not duplicate the snippet", fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf-8") === before);

// ─── installed as a project dependency ───────────────────────────────────────
// A real dependency, not a symlink: require.resolve follows symlinks to their
// realpath, which would defeat the project-relative calculation.
console.log("\nre-run with the package installed as a dependency");
const dep = path.join(tmp, "node_modules", "typegraph-mcp");
fs.mkdirSync(path.join(dep, "dist"), { recursive: true });
fs.writeFileSync(path.join(dep, "package.json"), JSON.stringify({ name: "typegraph-mcp", version: "0.1.0" }));
fs.writeFileSync(path.join(dep, "dist/server.cjs"), "// stand-in\n");
fs.writeFileSync(path.join(dep, "dist/check.cjs"), "// stand-in\n");
fs.writeFileSync(path.join(dep, "dist/cli.cjs"), "// stand-in\n");
run("setup", "--yes");

const mcpDep = readJson(".mcp.json");
const mcpDepServer = mcpDep.mcpServers?.["typegraph-mcp"];
check(
  "server path is now project-relative",
  mcpDepServer?.args?.[0] === "node_modules/typegraph-mcp/dist/server.cjs",
  mcpDepServer?.args?.[0],
);
check(
  "relative path resolves against the project root",
  fs.existsSync(path.resolve(tmp, mcpDepServer.args[0])),
);
check(
  "TYPEGRAPH_PROJECT_ROOT is '.' for a project-scoped config",
  mcpDepServer?.env?.TYPEGRAPH_PROJECT_ROOT === ".",
);
const ocDep = readJson("opencode.jsonc");
check(
  "opencode picks up the relative path too",
  ocDep.mcp?.["typegraph-mcp"]?.command?.[1] === "node_modules/typegraph-mcp/dist/server.cjs",
  ocDep.mcp?.["typegraph-mcp"]?.command?.[1],
);
const skillAfter = fs.readFileSync(path.join(tmp, ".claude/skills/deep-survey/SKILL.md"), "utf-8");
check(
  "skills re-templated to a relocation-safe installed copy",
  skillAfter.includes('node "./node_modules/typegraph-mcp/dist/cli.cjs" check') &&
    !skillAfter.includes(tmp),
);
check(
  "skill health check targets the consumer project",
  skillAfter.includes('--project-root "."') && skillAfter.includes('--tsconfig "./tsconfig.json"'),
);
check("project MCP config uses portable node from PATH", mcpDepServer?.command === "node");

console.log("\nabsolute in-project tsconfig is normalized before it reaches committed files");
run("setup", "--yes", "--tsconfig", path.join(tmp, "tsconfig.json"));
const normalizedMcp = readJson(".mcp.json").mcpServers?.["typegraph-mcp"];
const normalizedSkill = fs.readFileSync(
  path.join(tmp, ".claude/skills/deep-survey/SKILL.md"),
  "utf-8",
);
check(
  "MCP config stores a project-relative tsconfig",
  normalizedMcp?.env?.TYPEGRAPH_TSCONFIG === "./tsconfig.json",
  normalizedMcp?.env?.TYPEGRAPH_TSCONFIG,
);
check(
  "skill stores a project-relative tsconfig",
  normalizedSkill.includes('--tsconfig "./tsconfig.json"') && !normalizedSkill.includes(tmp),
);

console.log("\nout-of-project tsconfig is rejected before setup writes");
const outsideTsconfig = path.join(path.dirname(tmp), `${path.basename(tmp)}-outside.json`);
fs.writeFileSync(outsideTsconfig, "{}\n");
const configBeforeReject = fs.readFileSync(path.join(tmp, ".mcp.json"), "utf-8");
const skillBeforeReject = normalizedSkill;
const rejected = spawnSync(
  process.execPath,
  [cli, "setup", "--yes", "--project-root", tmp, "--tsconfig", outsideTsconfig],
  {
    cwd: tmp,
    env: { ...process.env, HOME: fakeHome },
    encoding: "utf-8",
  },
);
const rejectedOutput = `${rejected.stdout}${rejected.stderr}`;
check("outside tsconfig exits non-zero", rejected.status === 1, rejectedOutput);
check(
  "outside tsconfig error is explicit and concise",
  rejectedOutput.includes("must be inside the project root") && !rejectedOutput.includes("\n    at "),
  rejectedOutput,
);
check(
  "rejected setup leaves MCP config untouched",
  fs.readFileSync(path.join(tmp, ".mcp.json"), "utf-8") === configBeforeReject,
);
check(
  "rejected setup leaves skills untouched",
  fs.readFileSync(path.join(tmp, ".claude/skills/deep-survey/SKILL.md"), "utf-8") ===
    skillBeforeReject,
);
fs.rmSync(outsideTsconfig, { force: true });

console.log("\nremove");
run("remove");
check(".claude/skills cleaned", !fs.existsSync(path.join(tmp, ".claude/skills/tool-selection")));
check(".agents/skills cleaned", !fs.existsSync(path.join(tmp, ".agents/skills/tool-selection")));
check(".mcp.json entry deregistered", !readJson(".mcp.json").mcpServers?.["typegraph-mcp"]);
check(".cursor/mcp.json entry deregistered", !readJson(".cursor/mcp.json").mcpServers?.["typegraph-mcp"]);
const ocAfter = readJson("opencode.jsonc");
check("opencode entry deregistered", !ocAfter.mcp?.["typegraph-mcp"]);
check("user config still intact after remove", ocAfter.model === "anthropic/claude-sonnet-5");
check(
  "codex block removed",
  !fs.readFileSync(path.join(tmp, ".codex/config.toml"), "utf-8").includes("[mcp_servers.typegraph-mcp]"),
);
check(
  "CLAUDE.md snippet removed",
  !fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf-8").includes("TypeScript Navigation"),
);
check("the dependency itself is untouched", fs.existsSync(path.join(dep, "dist/server.cjs")));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nOK — installer round-trip clean" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
