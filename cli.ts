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

// ─── Types ───────────────────────────────────────────────────────────────────

type AgentId = "claude-code" | "cursor" | "codex" | "gemini" | "copilot";

interface AgentDef {
  name: string;
  /** Files to include in the plugin directory (agent-specific) */
  pluginFiles: string[];
  /** Agent instruction file to update (null if agent has no instruction file) */
  agentFile: string | null;
  /** Whether this agent discovers skills from .agents/skills/ at project root */
  needsAgentsSkills: boolean;
  /** Detect if this agent is likely in use based on project files */
  detect: (projectRoot: string) => boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AGENT_SNIPPET = `
## TypeScript Navigation (typegraph-mcp)

Use the \`ts_*\` MCP tools instead of grep/glob for navigating TypeScript code. They resolve through barrel files, re-exports, and project references — returning precise results, not string matches.

- **Point queries** (tsserver): \`ts_find_symbol\`, \`ts_definition\`, \`ts_references\`, \`ts_type_info\`, \`ts_navigate_to\`, \`ts_trace_chain\`, \`ts_blast_radius\`, \`ts_module_exports\`
- **Graph queries** (import graph): \`ts_dependency_tree\`, \`ts_dependents\`, \`ts_import_cycles\`, \`ts_shortest_path\`, \`ts_subgraph\`, \`ts_module_boundary\`
`.trimStart();

const SNIPPET_MARKER = "## TypeScript Navigation (typegraph-mcp)";

const PLUGIN_DIR_NAME = "plugins/typegraph-mcp";

const AGENT_IDS: AgentId[] = ["claude-code", "cursor", "codex", "gemini", "copilot"];

const AGENTS: Record<AgentId, AgentDef> = {
  "claude-code": {
    name: "Claude Code",
    pluginFiles: [
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "hooks/hooks.json",
      "scripts/ensure-deps.sh",
      "commands/check.md",
      "commands/test.md",
    ],
    agentFile: "CLAUDE.md",
    needsAgentsSkills: false,
    detect: (root) =>
      fs.existsSync(path.join(root, "CLAUDE.md")) ||
      fs.existsSync(path.join(root, ".claude")),
  },
  cursor: {
    name: "Cursor",
    pluginFiles: [".cursor-plugin/plugin.json"],
    agentFile: null,
    needsAgentsSkills: false,
    detect: (root) => fs.existsSync(path.join(root, ".cursor")),
  },
  codex: {
    name: "Codex CLI",
    pluginFiles: [],
    agentFile: "AGENTS.md",
    needsAgentsSkills: true,
    detect: (root) => fs.existsSync(path.join(root, "AGENTS.md")),
  },
  gemini: {
    name: "Gemini CLI",
    pluginFiles: ["gemini-extension.json"],
    agentFile: "GEMINI.md",
    needsAgentsSkills: true,
    detect: (root) => fs.existsSync(path.join(root, "GEMINI.md")),
  },
  copilot: {
    name: "GitHub Copilot",
    pluginFiles: [],
    agentFile: ".github/copilot-instructions.md",
    needsAgentsSkills: true,
    detect: (root) =>
      fs.existsSync(path.join(root, ".github/copilot-instructions.md")),
  },
};

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
  "pnpm-lock.yaml",
];

/** Skill files inside plugin dir (Claude Code + Cursor discover from skills/) */
const SKILL_FILES = [
  "skills/tool-selection/SKILL.md",
  "skills/impact-analysis/SKILL.md",
  "skills/refactor-safety/SKILL.md",
  "skills/dependency-audit/SKILL.md",
  "skills/code-exploration/SKILL.md",
];

/** .agents/skills/ copies inside plugin dir (source for project-root copies) */
const AGENTS_SKILL_FILES = [
  ".agents/skills/tool-selection/SKILL.md",
  ".agents/skills/impact-analysis/SKILL.md",
  ".agents/skills/refactor-safety/SKILL.md",
  ".agents/skills/dependency-audit/SKILL.md",
  ".agents/skills/code-exploration/SKILL.md",
];

const SKILL_NAMES = [
  "tool-selection",
  "impact-analysis",
  "refactor-safety",
  "dependency-audit",
  "code-exploration",
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

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
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

// ─── Agent Selection ─────────────────────────────────────────────────────────

function detectAgents(projectRoot: string): AgentId[] {
  return AGENT_IDS.filter((id) => AGENTS[id].detect(projectRoot));
}

async function selectAgents(projectRoot: string, yes: boolean): Promise<AgentId[]> {
  const detected = detectAgents(projectRoot);

  if (yes) {
    const selected = detected.length > 0 ? detected : [...AGENT_IDS];
    console.log("── Agent Selection ──────────────────────────────────────────");
    console.log("");
    console.log(`  Auto-selected: ${selected.map((id) => AGENTS[id].name).join(", ")}`);
    console.log("");
    return selected;
  }

  console.log("── Agent Selection ──────────────────────────────────────────");
  console.log("");
  console.log("  Select which AI agents to configure:");
  console.log("");

  for (let i = 0; i < AGENT_IDS.length; i++) {
    const id = AGENT_IDS[i]!;
    const agent = AGENTS[id];
    const isDetected = detected.includes(id);
    const marker = isDetected ? " (detected)" : "";
    const num = `${i + 1}.`.padEnd(3);
    console.log(`    ${num} ${agent.name.padEnd(16)}${marker}`);
  }

  console.log("");

  const defaultNums = detected.map((id) => AGENT_IDS.indexOf(id) + 1);
  const defaultStr = defaultNums.length > 0 ? defaultNums.join(",") : "all";

  const answer = await prompt(`  Enter numbers (e.g. 1,3,5), 'all', or Enter for [${defaultStr}]: `);

  let selected: AgentId[];

  if (answer === "") {
    selected = detected.length > 0 ? detected : [...AGENT_IDS];
  } else if (answer.toLowerCase() === "all") {
    selected = [...AGENT_IDS];
  } else {
    const nums = answer
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => n >= 1 && n <= AGENT_IDS.length);
    if (nums.length === 0) {
      console.log("  No valid selections — using detected agents.");
      selected = detected.length > 0 ? detected : [...AGENT_IDS];
    } else {
      selected = [...new Set(nums.map((n) => AGENT_IDS[n - 1]!))];
    }
  }

  console.log(`  Selected: ${selected.map((id) => AGENTS[id].name).join(", ")}`);
  console.log("");

  return selected;
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

  // 2. Agent selection
  const selectedAgents = await selectAgents(projectRoot, yes);

  const needsPluginSkills = selectedAgents.includes("claude-code") || selectedAgents.includes("cursor");
  const needsAgentsSkills = selectedAgents.some((id) => AGENTS[id].needsAgentsSkills);

  // 3. Build file list and embed plugin into project
  console.log("── Plugin Installation ──────────────────────────────────────");

  const targetDir = path.resolve(projectRoot, PLUGIN_DIR_NAME);
  const isUpdate = fs.existsSync(targetDir);

  if (isUpdate && !yes) {
    const overwrite = await confirm(`  ${PLUGIN_DIR_NAME}/ already exists. Update?`);
    if (!overwrite) {
      console.log("  Skipped plugin installation (existing copy preserved)");
      console.log("");
      await setupAgentInstructions(projectRoot, selectedAgents);
      await runVerification(targetDir, selectedAgents);
      return;
    }
  }

  // Assemble file list based on selected agents
  const filesToCopy = [...CORE_FILES];

  // Skills are always needed (either for in-plugin discovery or as source for .agents/skills/ copies)
  if (needsPluginSkills || needsAgentsSkills) {
    filesToCopy.push(...SKILL_FILES);
  }
  if (needsAgentsSkills) {
    filesToCopy.push(...AGENTS_SKILL_FILES);
  }

  // Add agent-specific files
  for (const agentId of selectedAgents) {
    filesToCopy.push(...AGENTS[agentId].pluginFiles);
  }

  // Copy files
  let copied = 0;
  for (const file of filesToCopy) {
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

  // 4. Install dependencies (use npm to avoid pnpm workspace interference)
  console.log("  Installing dependencies...");
  try {
    execSync("npm install", { cwd: targetDir, stdio: "pipe" });
    console.log("  Dependencies installed");
  } catch (err) {
    console.log(`  Warning: dependency install failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log("  Run manually: cd " + PLUGIN_DIR_NAME + " && npm install");
  }
  console.log("");

  // 5. Copy skills to .agents/skills/ for cross-platform discovery
  if (needsAgentsSkills) {
    const agentsNames = selectedAgents
      .filter((id) => AGENTS[id].needsAgentsSkills)
      .map((id) => AGENTS[id].name);

    console.log("── Cross-Platform Skills ────────────────────────────────────");
    const agentsSkillsDir = path.resolve(projectRoot, ".agents/skills");
    let copiedSkills = 0;
    for (const skill of SKILL_NAMES) {
      const src = path.join(targetDir, "skills", skill, "SKILL.md");
      const destDir = path.join(agentsSkillsDir, skill);
      const dest = path.join(destDir, "SKILL.md");
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dest)) {
        const srcContent = fs.readFileSync(src, "utf-8");
        const destContent = fs.readFileSync(dest, "utf-8");
        if (srcContent === destContent) continue;
      }
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, dest);
      copiedSkills++;
    }
    if (copiedSkills > 0) {
      console.log(`  Copied ${copiedSkills} skills to .agents/skills/ (${agentsNames.join(", ")})`);
    } else {
      console.log("  .agents/skills/ already up to date");
    }
    console.log("");
  }

  // 6. Remove old .claude/mcp.json entry if Claude Code is selected
  if (selectedAgents.includes("claude-code")) {
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
  }

  // 7. Agent instructions
  await setupAgentInstructions(projectRoot, selectedAgents);

  // 8. Verification
  await runVerification(targetDir, selectedAgents);
}

async function setupAgentInstructions(projectRoot: string, selectedAgents: AgentId[]): Promise<void> {
  // Collect agent instruction files for selected agents
  const agentFiles = selectedAgents
    .map((id) => AGENTS[id].agentFile)
    .filter((f): f is string => f !== null);

  if (agentFiles.length === 0) {
    return; // No agents with instruction files selected (e.g. Cursor only)
  }

  console.log("── Agent Instructions ───────────────────────────────────────");

  // Find existing files, resolve symlinks to deduplicate
  const seenRealPaths = new Map<string, string>(); // realPath -> first agentFile name
  const existingFiles: { file: string; realPath: string; hasSnippet: boolean }[] = [];
  for (const agentFile of agentFiles) {
    const filePath = path.resolve(projectRoot, agentFile);
    if (!fs.existsSync(filePath)) continue;
    const realPath = fs.realpathSync(filePath);

    const previousFile = seenRealPaths.get(realPath);
    if (previousFile) {
      console.log(`  ${agentFile}: same file as ${previousFile} (skipped)`);
      continue;
    }
    seenRealPaths.set(realPath, agentFile);
    const content = fs.readFileSync(filePath, "utf-8");
    existingFiles.push({ file: agentFile, realPath, hasSnippet: content.includes(SNIPPET_MARKER) });
  }

  if (existingFiles.length === 0) {
    console.log(`  No agent instruction files found (${agentFiles.join(", ")})`);
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
    const content = fs.readFileSync(target.realPath, "utf-8");
    const appendContent = (content.endsWith("\n") ? "" : "\n") + "\n" + AGENT_SNIPPET;
    fs.appendFileSync(target.realPath, appendContent);
    console.log(`  ${target.file}: appended typegraph-mcp instructions`);
    for (const f of existingFiles.slice(1)) {
      console.log(`  ${f.file}: skipped (instructions added to ${target.file})`);
    }
  }

  // Update --plugin-dir line in CLAUDE.md if Claude Code is selected
  if (selectedAgents.includes("claude-code")) {
    const claudeMdPath = path.resolve(projectRoot, "CLAUDE.md");
    if (fs.existsSync(claudeMdPath)) {
      let content = fs.readFileSync(claudeMdPath, "utf-8");
      const pluginDirPattern = /(`claude\s+)((?:--plugin-dir\s+\S+\s*)+)(`)/;
      const match = content.match(pluginDirPattern);

      if (match && !match[2]!.includes("./plugins/typegraph-mcp")) {
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
  }

  console.log("");
}

async function runVerification(pluginDir: string, selectedAgents: AgentId[]): Promise<void> {
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
    if (selectedAgents.includes("claude-code")) {
      console.log("  Load the plugin:  claude --plugin-dir ./plugins/typegraph-mcp");
      console.log("  Or add to your launch command alongside other plugins.");
    } else {
      console.log("  The typegraph-mcp tools are now available to your selected agents.");
    }
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
