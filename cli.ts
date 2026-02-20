#!/usr/bin/env npx tsx
/**
 * typegraph-mcp CLI — Setup, verify, and run the TypeGraph MCP server.
 *
 * Usage:
 *   typegraph-mcp setup   Install typegraph-mcp plugin into the current project
 *   typegraph-mcp check   Run health checks (12 checks)
 *   typegraph-mcp test    Run smoke tests (all 14 tools)
 *   typegraph-mcp start   Start the MCP server (stdin/stdout)
 *
 * Options:
 *   --yes   Skip confirmation prompts (accept all defaults)
 *   --help  Show help
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { execSync } from "node:child_process";
import { resolveConfig } from "./config.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const AGENT_SNIPPET = `
## TypeScript Navigation (typegraph-mcp)

Use the \`ts_*\` MCP tools instead of grep/glob for navigating TypeScript code. They resolve through barrel files, re-exports, and project references — returning precise results, not string matches.

- **Point queries** (tsserver): \`ts_find_symbol\`, \`ts_definition\`, \`ts_references\`, \`ts_type_info\`, \`ts_navigate_to\`, \`ts_trace_chain\`, \`ts_blast_radius\`, \`ts_module_exports\`
- **Graph queries** (import graph): \`ts_dependency_tree\`, \`ts_dependents\`, \`ts_import_cycles\`, \`ts_shortest_path\`, \`ts_subgraph\`, \`ts_module_boundary\`
`.trimStart();

const AGENT_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
];

const SNIPPET_MARKER = "## TypeScript Navigation (typegraph-mcp)";

const PLUGIN_DIR_NAME = "plugins/typegraph-mcp";

/** Files to copy when embedding the plugin into a project */
const PLUGIN_FILES = [
  // Plugin manifest & MCP config
  ".claude-plugin/plugin.json",
  ".mcp.json",
  // Hooks & scripts
  "hooks/hooks.json",
  "scripts/ensure-deps.sh",
  // Commands
  "commands/check.md",
  "commands/test.md",
  // Skills
  "skills/tool-selection/SKILL.md",
  "skills/impact-analysis/SKILL.md",
  "skills/refactor-safety/SKILL.md",
  "skills/dependency-audit/SKILL.md",
  "skills/code-exploration/SKILL.md",
  // Server & core modules
  "server.ts",
  "module-graph.ts",
  "tsserver-client.ts",
  "graph-queries.ts",
  "config.ts",
  "check.ts",
  "smoke-test.ts",
  "cli.ts",
  // Package manifest (for dependency install)
  "package.json",
  "pnpm-lock.yaml",
];

const HELP = `
typegraph-mcp — Type-aware codebase navigation for AI coding agents.

Usage: typegraph-mcp <command> [options]

Commands:
  setup   Install typegraph-mcp plugin into the current project
  check   Run health checks (12 checks)
  test    Run smoke tests (all 14 tools)
  start   Start the MCP server (stdin/stdout)

Options:
  --yes   Skip confirmation prompts (accept all defaults)
  --help  Show this help
`.trim();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [Y/n] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== "n");
    });
  });
}

function copyFile(src: string, dest: string): void {
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
  // Preserve executable bit for scripts
  if (src.endsWith(".sh")) {
    fs.chmodSync(dest, 0o755);
  }
}

// ─── Setup Command ───────────────────────────────────────────────────────────

async function setup(yes: boolean): Promise<void> {
  const sourceDir = import.meta.dirname;
  const projectRoot = process.cwd();

  console.log("");
  console.log("typegraph-mcp setup");
  console.log("===================");
  console.log(`Project: ${projectRoot}`);
  console.log(`Source:  ${sourceDir}`);
  console.log("");

  // 1. Validate project
  const pkgJsonPath = path.resolve(projectRoot, "package.json");
  const tsconfigPath = path.resolve(projectRoot, "tsconfig.json");

  if (!fs.existsSync(pkgJsonPath)) {
    console.log("  No package.json found in current directory.");
    console.log("  Run this command from the root of your TypeScript project.");
    process.exit(1);
  }

  if (!fs.existsSync(tsconfigPath)) {
    console.log("  No tsconfig.json found in current directory.");
    console.log("  typegraph-mcp requires a TypeScript project with a tsconfig.json.");
    process.exit(1);
  }

  console.log("  Found package.json and tsconfig.json");
  console.log("");

  // 2. Embed plugin into project
  console.log("── Plugin Installation ──────────────────────────────────────");

  const targetDir = path.resolve(projectRoot, PLUGIN_DIR_NAME);
  const isUpdate = fs.existsSync(targetDir);

  if (isUpdate && !yes) {
    const overwrite = await confirm(`  ${PLUGIN_DIR_NAME}/ already exists. Update?`);
    if (!overwrite) {
      console.log("  Skipped plugin installation (existing copy preserved)");
      console.log("");
      // Still continue with agent instructions and verification
      await setupAgentInstructions(projectRoot, yes);
      await runVerification(targetDir);
      return;
    }
  }

  // Copy all plugin files
  let copied = 0;
  for (const file of PLUGIN_FILES) {
    const src = path.join(sourceDir, file);
    const dest = path.join(targetDir, file);
    if (fs.existsSync(src)) {
      copyFile(src, dest);
      copied++;
    } else {
      console.log(`  Warning: source file not found: ${file}`);
    }
  }

  console.log(`  ${isUpdate ? "Updated" : "Installed"} ${copied} files to ${PLUGIN_DIR_NAME}/`);

  // 3. Install dependencies (use npm to avoid pnpm workspace interference)
  console.log("  Installing dependencies...");
  try {
    execSync("npm install", { cwd: targetDir, stdio: "pipe" });
    console.log("  Dependencies installed");
  } catch (err) {
    console.log(`  Warning: dependency install failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log("  Run manually: cd " + PLUGIN_DIR_NAME + " && npm install");
  }
  console.log("");

  // 4. Remove old .claude/mcp.json entry if present (plugin .mcp.json handles registration)
  const mcpJsonPath = path.resolve(projectRoot, ".claude/mcp.json");
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      if (mcpJson.mcpServers?.["typegraph"]) {
        delete mcpJson.mcpServers["typegraph"];
        fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
        console.log("  Removed old typegraph entry from .claude/mcp.json (plugin handles MCP registration)");
        console.log("");
      }
    } catch {
      // Ignore parse errors
    }
  }

  // 5. Agent instructions + plugin-dir line
  await setupAgentInstructions(projectRoot, yes);

  // 6. Verification
  await runVerification(targetDir);
}

async function setupAgentInstructions(projectRoot: string, _yes: boolean): Promise<void> {
  console.log("── Agent Instructions ───────────────────────────────────────");

  // Find all existing agent files and check which already have the snippet
  const existingFiles: { file: string; path: string; hasSnippet: boolean }[] = [];
  for (const agentFile of AGENT_FILES) {
    const filePath = path.resolve(projectRoot, agentFile);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    existingFiles.push({ file: agentFile, path: filePath, hasSnippet: content.includes(SNIPPET_MARKER) });
  }

  if (existingFiles.length === 0) {
    console.log("  No agent instruction files found (CLAUDE.md, AGENTS.md, GEMINI.md, etc.)");
    console.log("  Add this snippet to your agent instructions file:");
    console.log("");
    console.log(AGENT_SNIPPET.split("\n").map((l) => "    " + l).join("\n"));
  } else if (existingFiles.some((f) => f.hasSnippet)) {
    for (const f of existingFiles) {
      if (f.hasSnippet) {
        console.log(`  ${f.file}: already contains typegraph-mcp instructions`);
      } else {
        console.log(`  ${f.file}: skipped (instructions already in another file)`);
      }
    }
  } else {
    const target = existingFiles[0]!;
    const content = fs.readFileSync(target.path, "utf-8");
    const appendContent = (content.endsWith("\n") ? "" : "\n") + "\n" + AGENT_SNIPPET;
    fs.appendFileSync(target.path, appendContent);
    console.log(`  ${target.file}: appended typegraph-mcp instructions`);
    for (const f of existingFiles.slice(1)) {
      console.log(`  ${f.file}: skipped (instructions added to ${target.file})`);
    }
  }

  // Update --plugin-dir line in CLAUDE.md if it exists
  const claudeMdPath = path.resolve(projectRoot, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    let content = fs.readFileSync(claudeMdPath, "utf-8");
    const pluginDirPattern = /(`claude\s+)((?:--plugin-dir\s+\S+\s*)+)(`)/;
    const match = content.match(pluginDirPattern);

    if (match && !match[2]!.includes("./plugins/typegraph-mcp")) {
      // Ensure the existing flags end with a space before appending
      const existingFlags = match[2]!.trimEnd();
      content = content.replace(
        pluginDirPattern,
        `$1${existingFlags} --plugin-dir ./plugins/typegraph-mcp$3`
      );
      fs.writeFileSync(claudeMdPath, content);
      console.log("  CLAUDE.md: added --plugin-dir ./plugins/typegraph-mcp to plugin loading line");
    } else if (!match) {
      // No existing --plugin-dir line found — not an error, just skip
    } else {
      console.log("  CLAUDE.md: --plugin-dir already includes typegraph-mcp");
    }
  }

  console.log("");
}

async function runVerification(pluginDir: string): Promise<void> {
  console.log("── Verification ─────────────────────────────────────────────");
  console.log("");

  const config = resolveConfig(pluginDir);

  const { main: checkMain } = await import("./check.js");
  const checkResult = await checkMain(config);

  console.log("");

  if (checkResult.failed > 0) {
    console.log("  Health check has failures — fix the issues above before running smoke tests.");
    process.exit(1);
  }

  const { main: testMain } = await import("./smoke-test.js");
  const testResult = await testMain(config);

  console.log("");

  if (checkResult.failed === 0 && testResult.failed === 0) {
    console.log("Setup complete!");
    console.log("");
    console.log("  Load the plugin:  claude --plugin-dir ./plugins/typegraph-mcp");
    console.log("  Or add to your launch command alongside other plugins.");
    console.log("");
  } else {
    console.log("Setup completed with issues. Fix the failures above and re-run.");
    process.exit(1);
  }
}

// ─── Check Command ───────────────────────────────────────────────────────────

async function check(): Promise<void> {
  const { main: checkMain } = await import("./check.js");
  const result = await checkMain();
  process.exit(result.failed > 0 ? 1 : 0);
}

// ─── Test Command ────────────────────────────────────────────────────────────

async function test(): Promise<void> {
  const { main: testMain } = await import("./smoke-test.js");
  const result = await testMain();
  process.exit(result.failed > 0 ? 1 : 0);
}

// ─── Start Command ───────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await import("./server.js");
}

// ─── CLI Dispatch ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("-"));
const yes = args.includes("--yes") || args.includes("-y");
const help = args.includes("--help") || args.includes("-h");

if (help || !command) {
  console.log(HELP);
  process.exit(0);
}

switch (command) {
  case "setup":
    setup(yes).catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
    break;
  case "check":
    check().catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
    break;
  case "test":
    test().catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
    break;
  case "start":
    start().catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
    break;
  default:
    console.log(`Unknown command: ${command}`);
    console.log("");
    console.log(HELP);
    process.exit(1);
}
