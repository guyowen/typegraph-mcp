#!/usr/bin/env npx tsx
/**
 * typegraph-mcp CLI — Dispatch entry point.
 *
 * Commands are implemented in separate modules:
 *   src/cli/setup.ts   — setup command
 *   src/cli/remove.ts  — remove command
 *
 * Small commands (check, test, bench, start, clean) remain here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";
import { resolveConfig } from "./config.js";
import { cleanDiskCache } from "./disk-cache.js";
import {
  type AgentId,
  type AgentDef,
  type LegacyGlobalCodexCleanup,
  type RemovePluginOptions,
  PLUGIN_DIR_NAME,
  AGENT_IDS,
  AGENTS,
  detectAgents,
} from "./src/cli/agents/index.js";

// Re-export for backward compatibility
export { PLUGIN_DIR_NAME, AGENT_IDS, AGENTS, detectAgents };
export type {
  AgentId,
  AgentDef,
  LegacyGlobalCodexCleanup,
  RemovePluginOptions,
};

// Re-export command functions for backward compatibility
export { registerAgentJsonMcp } from "./src/cli/setup.js";
export { deregisterAgentJsonMcp } from "./src/cli/remove.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const AGENT_SNIPPET = `
## TypeScript Navigation (typegraph-mcp)

Where suitable, use the \`ts_*\` MCP tools instead of grep/glob for navigating TypeScript code. They resolve through barrel files, re-exports, and project references and return semantic results instead of string matches.

- Point queries: \`ts_find_symbol\`, \`ts_definition\`, \`ts_references\`, \`ts_type_info\`, \`ts_navigate_to\`, \`ts_trace_chain\`, \`ts_blast_radius\`, \`ts_module_exports\`
- Graph queries: \`ts_dependency_tree\`, \`ts_dependents\`, \`ts_import_cycles\`, \`ts_shortest_path\`, \`ts_subgraph\`, \`ts_module_boundary\`

Start with the navigation tools before reading entire files. Use direct file reads only after the MCP tools identify the exact symbols or lines that matter.

For quick architectural insight, prefer composition modules and entrypoints over top-level barrel files. If \`ts_module_exports\` on an \`index.ts\` or other barrel looks empty or uninformative, pivot to the app entrypoint, router, handler, service composition root, or API module that wires real behavior together.

Use \`rg\` or \`grep\` when semantic symbol navigation is not the right tool, especially for:

- docs, config, SQL, migrations, JSON, env vars, route strings, and other non-TypeScript assets
- broad text discovery when you do not yet know the symbol name
- exact string matching across the repo
- validating wording or finding repeated plan/document references

Practical rule:

- use \`ts_*\` first for TypeScript symbol definition, references, types, and dependency analysis
- use \`rg\`/\`grep\` for text search and non-TypeScript exploration
- combine both when a task spans TypeScript code and surrounding docs/config
`.trimStart();

const SNIPPET_MARKER = "## TypeScript Navigation (typegraph-mcp)";
const CLAUDE_NODE_PLACEHOLDER = "__TYPEGRAPH_NODE__";

/** Core files always installed (server, modules, config, package manifest) */
const CORE_FILES = [
  "server.ts",
  "module-graph.ts",
  "tsserver-client.ts",
  "graph-queries.ts",
  "config.ts",
  "check.ts",
  "smoke-test.ts",
  "cli.ts",
  "package.json",
  "export-resolver.ts",
  "tsconfig-patch.ts",
  "disk-cache.ts",
  "src/cli/setup.ts",
  "src/cli/remove.ts",
  "src/cli/agents/index.ts",
  "src/cli/agents/registry.ts",
  "src/cli/agents/toml-helpers.ts",
  "src/cli/agents/types.ts",
  "src/server/index.ts",
  "src/server/types.ts",
  "src/server/navigation.ts",
  "src/server/graph.ts",
];

/** Skill files inside plugin dir (Claude Code + Cursor discover from skills/) */
const SKILL_FILES = [
  "skills/tool-selection/SKILL.md",
  "skills/impact-analysis/SKILL.md",
  "skills/refactor-safety/SKILL.md",
  "skills/dependency-audit/SKILL.md",
  "skills/code-exploration/SKILL.md",
  "skills/deep-survey/SKILL.md",
];

const SKILL_NAMES = [
  "tool-selection",
  "impact-analysis",
  "refactor-safety",
  "dependency-audit",
  "code-exploration",
  "deep-survey",
];

const HELP = `
typegraph-mcp — Type-aware codebase navigation for AI coding agents.

Usage: typegraph-mcp <command> [options]

Commands:
  setup    Install typegraph-mcp plugin into the current project
  remove   Uninstall typegraph-mcp from the current project
  check    Run health checks (12 checks)
  test     Run smoke tests (all 14 tools)
  bench    Run benchmarks (token, latency, accuracy)
  start    Start the MCP server (stdin/stdout)
  clean    Remove disk cache (node_modules/.cache/typegraph-mcp/)

Options:
  --yes                 Skip confirmation prompts (accept all defaults)
  --clean-global-codex  Also remove a stale global Codex MCP entry for this project
  --help                Show this help
`.trim();

// ─── Small Commands ──────────────────────────────────────────────────────────

function resolvePluginDir(): string {
  // Prefer the installed plugin in the user's project over the npx cache
  const installed = path.resolve(process.cwd(), PLUGIN_DIR_NAME);
  if (fs.existsSync(installed)) return installed;
  // Fall back to the source directory (running from the repo itself)
  return path.basename(import.meta.dirname) === "dist"
    ? path.resolve(import.meta.dirname, "..")
    : import.meta.dirname;
}

async function check(): Promise<void> {
  const config = resolveConfig(resolvePluginDir());
  const { main: checkMain } = await import("./check.js");
  const result = await checkMain(config);
  process.exit(result.failed > 0 ? 1 : 0);
}

async function test(): Promise<void> {
  const config = resolveConfig(resolvePluginDir());
  const { main: testMain } = await import("./smoke-test.js");
  const result = await testMain(config);
  process.exit(result.failed > 0 ? 1 : 0);
}

async function benchmark(): Promise<void> {
  const config = resolveConfig(resolvePluginDir());
  const { main: benchMain } = await import("./benchmark.js");
  await benchMain(config);
}

function clean(): void {
  const projectRoot = process.cwd();
  const cleaned = cleanDiskCache(projectRoot);
  if (cleaned) {
    console.log("Disk cache cleaned");
  } else {
    console.log("No disk cache found");
  }
}

async function start(): Promise<void> {
  await import("./server.js");
}

// ─── CLI Dispatch ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const isDirectRun =
  process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");

if (isDirectRun) {
  const command = args.find((a) => !a.startsWith("-"));
  const yes = args.includes("--yes") || args.includes("-y");
  const help = args.includes("--help") || args.includes("-h");

  // Clear npx download noise (warnings, "Ok to proceed?" prompt)
  process.stdout.write("\x1Bc");

  if (help || !command) {
    console.log(HELP);
    process.exit(0);
  }

  switch (command) {
    case "setup": {
      const { setup } = await import("./src/cli/setup.js");
      setup(yes).catch((err) => {
        console.error("Fatal:", err);
        process.exit(1);
      });
      break;
    }
    case "remove": {
      const { remove } = await import("./src/cli/remove.js");
      remove(yes).catch((err) => {
        console.error("Fatal:", err);
        process.exit(1);
      });
      break;
    }
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
    case "bench":
    case "benchmark":
      benchmark().catch((err) => {
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
    case "clean":
      clean();
      break;
    default:
      console.log(`Unknown command: ${command}`);
      console.log("");
      console.log(HELP);
      process.exit(1);
  }
}
