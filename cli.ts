#!/usr/bin/env npx tsx
/**
 * typegraph-mcp CLI — Setup, verify, and run the TypeGraph MCP server.
 *
 * Usage:
 *   typegraph-mcp setup   Set up typegraph-mcp in the current project
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

const SNIPPET_MARKER = "typegraph-mcp";

const HELP = `
typegraph-mcp — Type-aware codebase navigation for AI coding agents.

Usage: typegraph-mcp <command> [options]

Commands:
  setup   Set up typegraph-mcp in the current project
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

// ─── Setup Command ───────────────────────────────────────────────────────────

async function setup(yes: boolean): Promise<void> {
  const toolDir = import.meta.dirname;
  const projectRoot = process.cwd();

  console.log("");
  console.log("typegraph-mcp setup");
  console.log("===================");
  console.log(`Project: ${projectRoot}`);
  console.log(`Tool:    ${toolDir}`);
  console.log("");

  // 1. Detect project
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

  // Determine if tool is embedded or external
  const toolIsEmbedded = toolDir.startsWith(projectRoot + path.sep);
  const serverPath = toolIsEmbedded
    ? "./" + path.relative(projectRoot, path.join(toolDir, "server.ts"))
    : path.resolve(toolDir, "server.ts");

  // 2. Create/update .claude/mcp.json
  console.log("── MCP Registration ─────────────────────────────────────────");

  const claudeDir = path.resolve(projectRoot, ".claude");
  const mcpJsonPath = path.resolve(claudeDir, "mcp.json");

  const newEntry = {
    command: "npx",
    args: ["tsx", serverPath],
    env: {
      TYPEGRAPH_PROJECT_ROOT: ".",
      TYPEGRAPH_TSCONFIG: "./tsconfig.json",
    },
  };

  let mcpJson: { mcpServers?: Record<string, unknown> } = {};
  let shouldWrite = true;
  let actionLabel = "Created";

  if (fs.existsSync(mcpJsonPath)) {
    try {
      mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      if (mcpJson.mcpServers?.["typegraph"]) {
        if (!yes) {
          const overwrite = await confirm("  typegraph entry already exists in .claude/mcp.json. Overwrite?");
          if (!overwrite) {
            console.log("  Skipped MCP registration (existing entry preserved)");
            console.log("");
            shouldWrite = false;
          }
        }
        actionLabel = "Updated";
      } else {
        actionLabel = "Updated";
      }
    } catch {
      console.log("  Warning: .claude/mcp.json exists but is invalid JSON. Will overwrite.");
      mcpJson = {};
    }
  }

  if (shouldWrite) {
    if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
    mcpJson.mcpServers["typegraph"] = newEntry;

    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
    console.log(`  ${actionLabel} .claude/mcp.json`);
    console.log(`  Server: ${serverPath}`);
    console.log("");
  }

  // 3. Append agent instructions
  console.log("── Agent Instructions ───────────────────────────────────────");

  let anyFileUpdated = false;
  let anyFileFound = false;

  for (const agentFile of AGENT_FILES) {
    const filePath = path.resolve(projectRoot, agentFile);
    if (!fs.existsSync(filePath)) continue;

    anyFileFound = true;
    const content = fs.readFileSync(filePath, "utf-8");

    if (content.includes(SNIPPET_MARKER)) {
      console.log(`  ${agentFile}: already contains typegraph-mcp instructions`);
      continue;
    }

    const appendContent = (content.endsWith("\n") ? "" : "\n") + "\n" + AGENT_SNIPPET;
    fs.appendFileSync(filePath, appendContent);
    console.log(`  ${agentFile}: appended typegraph-mcp instructions`);
    anyFileUpdated = true;
  }

  if (!anyFileFound) {
    console.log("  No agent instruction files found (CLAUDE.md, AGENTS.md, GEMINI.md, etc.)");
    console.log("  Add this snippet to your agent instructions file:");
    console.log("");
    console.log(AGENT_SNIPPET.split("\n").map((l) => "    " + l).join("\n"));
  } else if (!anyFileUpdated) {
    console.log("  All agent files already have typegraph-mcp instructions");
  }

  console.log("");

  // 4. Run check + test
  console.log("── Verification ─────────────────────────────────────────────");
  console.log("");

  const config = resolveConfig(toolDir);

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
    console.log("Setup complete. Restart your agent session to use ts_* tools.");
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
