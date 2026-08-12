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
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
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
  "instructions": ["see https://example.com//docs"]
}
`,
);

// HOME is redirected because Antigravity's MCP config is global, and `remove`
// deregisters it unconditionally — an uninstall run must not reach into the
// developer's real ~/.gemini while the suite is running.
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

const run = (...args: string[]): string =>
  execFileSync(process.execPath, [path.join(repoRoot, "src/cli.cjs"), ...args], {
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
check("project .mcp.json written (Claude Code)", !!mcp.mcpServers?.typegraph);
check(
  "not a plugin .mcp.json",
  !fs.existsSync(path.join(tmp, "plugins/typegraph-mcp/.mcp.json")),
);
check(
  "server path is absolute while the package is not a dependency",
  path.isAbsolute(mcp.mcpServers?.typegraph?.args?.[0] ?? ""),
  mcp.mcpServers?.typegraph?.args?.[0],
);
check(
  "server path exists on disk",
  fs.existsSync(path.resolve(tmp, mcp.mcpServers.typegraph.args[0])),
);

const cursor = readJson(".cursor/mcp.json");
check("cursor mcp.json written", !!cursor.mcpServers?.typegraph);

const oc = readJson("opencode.jsonc");
check("opencode.jsonc parsed despite comments", !!oc.mcp?.typegraph, "entry present");
check("opencode entry uses type:local", oc.mcp?.typegraph?.type === "local", oc.mcp?.typegraph?.type);
check(
  "opencode command is ONE array",
  Array.isArray(oc.mcp?.typegraph?.command) && oc.mcp.typegraph.command.length === 2,
  JSON.stringify(oc.mcp?.typegraph?.command),
);
check(
  "no tsx in the invocation (plain node trampoline)",
  !JSON.stringify(oc.mcp?.typegraph?.command).includes("tsx"),
);
check("existing user config preserved", oc.model === "anthropic/claude-sonnet-5", oc.model);
check(
  "string containing // not corrupted",
  oc.instructions?.[0] === "see https://example.com//docs",
  oc.instructions?.[0],
);

const toml = fs.readFileSync(path.join(tmp, ".codex/config.toml"), "utf-8");
check("codex toml block written", toml.includes("[mcp_servers.typegraph]"));

console.log("\nagent instruction files");
check("CLAUDE.md snippet", fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf-8").includes("TypeScript Navigation"));
check("AGENTS.md snippet", fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf-8").includes("TypeScript Navigation"));

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
run("setup", "--yes");

const mcpDep = readJson(".mcp.json");
check(
  "server path is now project-relative",
  mcpDep.mcpServers?.typegraph?.args?.[0] === path.join("node_modules", "typegraph-mcp", "dist", "server.cjs"),
  mcpDep.mcpServers?.typegraph?.args?.[0],
);
check(
  "relative path resolves against the project root",
  fs.existsSync(path.resolve(tmp, mcpDep.mcpServers.typegraph.args[0])),
);
check(
  "TYPEGRAPH_PROJECT_ROOT is '.' for a project-scoped config",
  mcpDep.mcpServers?.typegraph?.env?.TYPEGRAPH_PROJECT_ROOT === ".",
);
const ocDep = readJson("opencode.jsonc");
check(
  "opencode picks up the relative path too",
  ocDep.mcp?.typegraph?.command?.[1] === path.join("node_modules", "typegraph-mcp", "dist", "server.cjs"),
  ocDep.mcp?.typegraph?.command?.[1],
);
const skillAfter = fs.readFileSync(path.join(tmp, ".claude/skills/deep-survey/SKILL.md"), "utf-8");
check("skills re-templated to the installed copy", skillAfter.includes(dep));

console.log("\nremove");
run("remove");
check(".claude/skills cleaned", !fs.existsSync(path.join(tmp, ".claude/skills/tool-selection")));
check(".agents/skills cleaned", !fs.existsSync(path.join(tmp, ".agents/skills/tool-selection")));
check(".mcp.json entry deregistered", !readJson(".mcp.json").mcpServers?.typegraph);
check(".cursor/mcp.json entry deregistered", !readJson(".cursor/mcp.json").mcpServers?.typegraph);
const ocAfter = readJson("opencode.jsonc");
check("opencode entry deregistered", !ocAfter.mcp?.typegraph);
check("user config still intact after remove", ocAfter.model === "anthropic/claude-sonnet-5");
check(
  "codex block removed",
  !fs.readFileSync(path.join(tmp, ".codex/config.toml"), "utf-8").includes("[mcp_servers.typegraph]"),
);
check(
  "CLAUDE.md snippet removed",
  !fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf-8").includes("TypeScript Navigation"),
);
check("the dependency itself is untouched", fs.existsSync(path.join(dep, "dist/server.cjs")));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nOK — installer round-trip clean" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
