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
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
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
];

/** Skill files inside plugin dir (Claude Code + Cursor discover from skills/) */
const SKILL_FILES = [
  "skills/tool-selection/SKILL.md",
  "skills/impact-analysis/SKILL.md",
  "skills/refactor-safety/SKILL.md",
  "skills/dependency-audit/SKILL.md",
  "skills/code-exploration/SKILL.md",
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
  setup    Install typegraph-mcp plugin into the current project
  remove   Uninstall typegraph-mcp from the current project
  check    Run health checks (12 checks)
  test     Run smoke tests (all 14 tools)
  bench    Run benchmarks (token, latency, accuracy)
  start    Start the MCP server (stdin/stdout)

Options:
  --yes   Skip confirmation prompts (accept all defaults)
  --help  Show this help
`.trim();

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── MCP Server Registration ────────────────────────────────────────────────

const MCP_SERVER_ENTRY = {
  command: "npx",
  args: ["tsx", "./plugins/typegraph-mcp/server.ts"],
  env: {
    TYPEGRAPH_PROJECT_ROOT: ".",
    TYPEGRAPH_TSCONFIG: "./tsconfig.json",
  },
};

/** Register the typegraph MCP server in agent-specific config files */
function registerMcpServers(projectRoot: string, selectedAgents: AgentId[]): void {
  if (selectedAgents.includes("cursor")) {
    registerJsonMcp(projectRoot, ".cursor/mcp.json", "mcpServers");
  }
  if (selectedAgents.includes("codex")) {
    registerCodexMcp(projectRoot);
  }
  if (selectedAgents.includes("copilot")) {
    registerJsonMcp(projectRoot, ".vscode/mcp.json", "servers");
  }
}

/** Deregister the typegraph MCP server from all agent config files */
function deregisterMcpServers(projectRoot: string): void {
  deregisterJsonMcp(projectRoot, ".cursor/mcp.json", "mcpServers");
  deregisterCodexMcp(projectRoot);
  deregisterJsonMcp(projectRoot, ".vscode/mcp.json", "servers");
}

/** Register MCP server in a JSON config file (Cursor or Copilot format) */
function registerJsonMcp(projectRoot: string, configPath: string, rootKey: string): void {
  const fullPath = path.resolve(projectRoot, configPath);
  let config: Record<string, unknown> = {};

  if (fs.existsSync(fullPath)) {
    try {
      config = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    } catch {
      p.log.warn(`Could not parse ${configPath} — skipping MCP registration`);
      return;
    }
  }

  const servers = (config[rootKey] as Record<string, unknown>) ?? {};
  const entry: Record<string, unknown> = { ...MCP_SERVER_ENTRY };
  // Copilot requires "type": "stdio"
  if (rootKey === "servers") {
    entry.type = "stdio";
  }
  servers["typegraph"] = entry;
  config[rootKey] = servers;

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, JSON.stringify(config, null, 2) + "\n");
  p.log.success(`${configPath}: registered typegraph MCP server`);
}

/** Deregister MCP server from a JSON config file */
function deregisterJsonMcp(projectRoot: string, configPath: string, rootKey: string): void {
  const fullPath = path.resolve(projectRoot, configPath);
  if (!fs.existsSync(fullPath)) return;

  try {
    const config = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    const servers = config[rootKey];
    if (!servers || !servers["typegraph"]) return;

    delete servers["typegraph"];

    // Clean up empty objects
    if (Object.keys(servers).length === 0) {
      delete config[rootKey];
    }

    // If config is now empty, remove the file
    if (Object.keys(config).length === 0) {
      fs.unlinkSync(fullPath);
    } else {
      fs.writeFileSync(fullPath, JSON.stringify(config, null, 2) + "\n");
    }
    p.log.info(`${configPath}: removed typegraph MCP server`);
  } catch {
    // Ignore parse errors
  }
}

/** Register MCP server in Codex CLI's TOML config */
function registerCodexMcp(projectRoot: string): void {
  const configPath = ".codex/config.toml";
  const fullPath = path.resolve(projectRoot, configPath);
  let content = "";

  if (fs.existsSync(fullPath)) {
    content = fs.readFileSync(fullPath, "utf-8");
    // Already registered?
    if (content.includes("[mcp_servers.typegraph]")) {
      p.log.info(`${configPath}: typegraph MCP server already registered`);
      return;
    }
  }

  const block = [
    "",
    "[mcp_servers.typegraph]",
    'command = "npx"',
    'args = ["tsx", "./plugins/typegraph-mcp/server.ts"]',
    'env = { TYPEGRAPH_PROJECT_ROOT = ".", TYPEGRAPH_TSCONFIG = "./tsconfig.json" }',
    "",
  ].join("\n");

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const newContent = content ? content.trimEnd() + "\n" + block : block.trimStart();
  fs.writeFileSync(fullPath, newContent);
  p.log.success(`${configPath}: registered typegraph MCP server`);
}

/** Deregister MCP server from Codex CLI's TOML config */
function deregisterCodexMcp(projectRoot: string): void {
  const configPath = ".codex/config.toml";
  const fullPath = path.resolve(projectRoot, configPath);
  if (!fs.existsSync(fullPath)) return;

  let content = fs.readFileSync(fullPath, "utf-8");
  if (!content.includes("[mcp_servers.typegraph]")) return;

  // Remove the [mcp_servers.typegraph] section (stops at next section header or end of file)
  content = content.replace(
    /\n?\[mcp_servers\.typegraph\]\n[\s\S]*?(?=\n\[|$)/,
    ""
  );

  // Clean up multiple trailing newlines
  content = content.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  if (content.trim() === "") {
    fs.unlinkSync(fullPath);
  } else {
    fs.writeFileSync(fullPath, content);
  }
  p.log.info(`${configPath}: removed typegraph MCP server`);
}

// ─── TSConfig Exclude ─────────────────────────────────────────────────────────

function ensureTsconfigExclude(projectRoot: string): void {
  const tsconfigPath = path.resolve(projectRoot, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return;

  try {
    const raw = fs.readFileSync(tsconfigPath, "utf-8");
    // Strip single-line comments (// ...) and trailing commas for JSON.parse
    const stripped = raw
      .replace(/\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1");
    const tsconfig = JSON.parse(stripped);

    const exclude: string[] = tsconfig.exclude || [];
    if (exclude.some((e: string) => e === "plugins" || e === "plugins/**" || e === "plugins/*")) {
      return; // Already excluded
    }

    // Insert "plugins/**" into the exclude array in the original file
    if (raw.includes('"exclude"')) {
      // Existing exclude array — append to it
      const updated = raw.replace(
        /("exclude"\s*:\s*\[)([\s\S]*?)(\])/,
        (_match, open, items, close) => {
          const trimmed = items.trimEnd();
          const needsComma = trimmed.length > 0 && !trimmed.endsWith(",");
          return `${open}${items.trimEnd()}${needsComma ? "," : ""}\n    "plugins/**"${close}`;
        }
      );
      fs.writeFileSync(tsconfigPath, updated);
    } else {
      // No exclude field — add one before the closing brace
      const lastBrace = raw.lastIndexOf("}");
      if (lastBrace !== -1) {
        const before = raw.slice(0, lastBrace).trimEnd();
        const needsComma = !before.endsWith(",") && !before.endsWith("{");
        const patched = `${before}${needsComma ? "," : ""}\n  "exclude": ["plugins/**"]\n}\n`;
        fs.writeFileSync(tsconfigPath, patched);
      }
    }

    p.log.success('Added "plugins/**" to tsconfig.json exclude (prevents build errors)');
  } catch {
    // Don't fail setup over tsconfig parsing issues
    p.log.warn('Could not update tsconfig.json — manually add "plugins/**" to the exclude array to prevent build errors');
  }
}

// ─── ESLint Ignore ───────────────────────────────────────────────────────────

function ensureEslintIgnore(projectRoot: string): void {
  const eslintConfigNames = ["eslint.config.mjs", "eslint.config.js", "eslint.config.ts", "eslint.config.cjs"];
  const eslintConfigFile = eslintConfigNames.find((name) => fs.existsSync(path.resolve(projectRoot, name)));
  if (!eslintConfigFile) return;
  const eslintConfigPath = path.resolve(projectRoot, eslintConfigFile);

  try {
    const raw = fs.readFileSync(eslintConfigPath, "utf-8");
    const pattern = /["']plugins\/\*\*["']/;
    if (pattern.test(raw)) return; // Already ignored

    // Strategy 1: Append to an existing ignores array
    const ignoresArrayRe = /(ignores\s*:\s*\[)([\s\S]*?)(\])/;
    const match = raw.match(ignoresArrayRe);
    if (match) {
      const updated = raw.replace(ignoresArrayRe, (_m, open, items, close) => {
        const trimmed = items.trimEnd();
        const needsComma = trimmed.length > 0 && !trimmed.endsWith(",");
        return `${open}${items.trimEnd()}${needsComma ? "," : ""} "plugins/**"${close}`;
      });
      fs.writeFileSync(eslintConfigPath, updated);
      p.log.success(`Added "plugins/**" to ${eslintConfigFile} ignores`);
      return;
    }

    // Strategy 2: Insert a new ignores object at the start of the exported array
    // Matches: export default [ or export default tseslint.config(
    const exportArrayRe = /(export\s+default\s+(?:\w+\.config\(|\[))\s*\n?/;
    if (exportArrayRe.test(raw)) {
      const updated = raw.replace(exportArrayRe, (m) => {
        return `${m}  { ignores: ["plugins/**"] },\n`;
      });
      fs.writeFileSync(eslintConfigPath, updated);
      p.log.success(`Added "plugins/**" to ${eslintConfigFile} ignores`);
      return;
    }

    p.log.warn(`Could not patch ${eslintConfigFile} — manually add "plugins/**" to the ignores array`);
  } catch {
    p.log.warn(`Could not update ${eslintConfigFile} — manually add "plugins/**" to the ignores array`);
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
    p.log.info(`Auto-selected: ${selected.map((id) => AGENTS[id].name).join(", ")}`);
    return selected;
  }

  p.log.info("space = toggle  |  up/down = navigate  |  enter = confirm");

  const result = await p.multiselect({
    message: "Select which AI agents to configure:",
    options: AGENT_IDS.map((id) => ({
      value: id,
      label: AGENTS[id].name,
      hint: detected.includes(id) ? "detected" : undefined,
    })),
    initialValues: detected.length > 0 ? detected : [...AGENT_IDS],
    required: false,
  });

  if (p.isCancel(result)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const selected = (result as AgentId[]).length > 0 ? (result as AgentId[]) : (detected.length > 0 ? detected : [...AGENT_IDS]);

  p.log.info(`Selected: ${selected.map((id) => AGENTS[id].name).join(", ")}`);

  return selected;
}

// ─── Setup Command ───────────────────────────────────────────────────────────

async function setup(yes: boolean): Promise<void> {
  const sourceDir = path.basename(import.meta.dirname) === "dist"
    ? path.resolve(import.meta.dirname, "..")
    : import.meta.dirname;
  const projectRoot = process.cwd();

  process.stdout.write("\x1Bc"); // Clear terminal
  p.intro("TypeGraph MCP Setup");

  p.log.info(`Project: ${projectRoot}`);

  // 1. Validate project
  const pkgJsonPath = path.resolve(projectRoot, "package.json");
  const tsconfigPath = path.resolve(projectRoot, "tsconfig.json");

  if (!fs.existsSync(pkgJsonPath)) {
    p.cancel("No package.json found. Run this from the root of your TypeScript project.");
    process.exit(1);
  }

  if (!fs.existsSync(tsconfigPath)) {
    p.cancel("No tsconfig.json found. typegraph-mcp requires a TypeScript project.");
    process.exit(1);
  }

  p.log.success("Found package.json and tsconfig.json");

  // 2. Check for existing installation
  const targetDir = path.resolve(projectRoot, PLUGIN_DIR_NAME);
  const isUpdate = fs.existsSync(targetDir);

  if (isUpdate && !yes) {
    const action = await p.select({
      message: `${PLUGIN_DIR_NAME}/ already exists.`,
      options: [
        { value: "update", label: "Update", hint: "reinstall plugin files" },
        { value: "remove", label: "Remove", hint: "uninstall typegraph-mcp from this project" },
        { value: "exit", label: "Exit", hint: "keep existing installation" },
      ],
    });

    if (p.isCancel(action)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (action === "remove") {
      await removePlugin(projectRoot, targetDir);
      return;
    }

    if (action === "exit") {
      p.outro("No changes made.");
      return;
    }
  }

  // 3. Agent selection
  const selectedAgents = await selectAgents(projectRoot, yes);

  const needsPluginSkills = selectedAgents.includes("claude-code") || selectedAgents.includes("cursor");
  const needsAgentsSkills = selectedAgents.some((id) => AGENTS[id].needsAgentsSkills);

  p.log.step(`Installing to ${PLUGIN_DIR_NAME}/...`);

  const s = p.spinner();
  s.start("Copying files...");

  // Assemble file list based on selected agents
  const filesToCopy = [...CORE_FILES];

  // Skills are always needed (either for in-plugin discovery or as source for .agents/skills/ copies)
  if (needsPluginSkills || needsAgentsSkills) {
    filesToCopy.push(...SKILL_FILES);
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
      p.log.warn(`Source file not found: ${file}`);
    }
  }

  s.message("Installing dependencies...");
  try {
    execSync("npm install", { cwd: targetDir, stdio: "pipe" });
    s.stop(`${isUpdate ? "Updated" : "Installed"} ${copied} files with dependencies`);
  } catch (err) {
    s.stop(`${isUpdate ? "Updated" : "Installed"} ${copied} files`);
    p.log.warn(`Dependency install failed: ${err instanceof Error ? err.message : String(err)}`);
    p.log.info(`Run manually: cd ${PLUGIN_DIR_NAME} && npm install`);
  }

  // 4. Copy skills to .agents/skills/ for cross-platform discovery
  if (needsAgentsSkills) {
    const agentsNames = selectedAgents
      .filter((id) => AGENTS[id].needsAgentsSkills)
      .map((id) => AGENTS[id].name);

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
      p.log.success(`Copied ${copiedSkills} skills to .agents/skills/ (${agentsNames.join(", ")})`);
    } else {
      p.log.info(".agents/skills/ already up to date");
    }
  }

  // 5. Remove old .claude/mcp.json entry if Claude Code is selected
  if (selectedAgents.includes("claude-code")) {
    const mcpJsonPath = path.resolve(projectRoot, ".claude/mcp.json");
    if (fs.existsSync(mcpJsonPath)) {
      try {
        const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
        if (mcpJson.mcpServers?.["typegraph"]) {
          delete mcpJson.mcpServers["typegraph"];
          fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
          p.log.info("Removed old typegraph entry from .claude/mcp.json");
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  // 6. Agent instructions
  await setupAgentInstructions(projectRoot, selectedAgents);

  // 7. Register MCP server in agent-specific configs
  registerMcpServers(projectRoot, selectedAgents);

  // 8. Ensure plugins/ is excluded from tsconfig
  ensureTsconfigExclude(projectRoot);

  // 9. Ensure plugins/ is ignored by ESLint
  ensureEslintIgnore(projectRoot);

  // 10. Verification
  await runVerification(targetDir, selectedAgents);
}

// ─── Remove Command ──────────────────────────────────────────────────────────

async function removePlugin(projectRoot: string, pluginDir: string): Promise<void> {
  const s = p.spinner();
  s.start("Removing typegraph-mcp...");

  // 1. Remove plugin directory
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true });
  }

  // 2. Remove .agents/skills/ entries (only typegraph-mcp skills, not the whole dir)
  const agentsSkillsDir = path.resolve(projectRoot, ".agents/skills");
  for (const skill of SKILL_NAMES) {
    const skillDir = path.join(agentsSkillsDir, skill);
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true });
    }
  }
  // Clean up .agents/skills/ and .agents/ if empty
  if (fs.existsSync(agentsSkillsDir) && fs.readdirSync(agentsSkillsDir).length === 0) {
    fs.rmSync(agentsSkillsDir, { recursive: true });
    const agentsDir = path.resolve(projectRoot, ".agents");
    if (fs.existsSync(agentsDir) && fs.readdirSync(agentsDir).length === 0) {
      fs.rmSync(agentsDir, { recursive: true });
    }
  }

  // 3. Remove agent instruction snippet from all known agent files
  const allAgentFiles = AGENT_IDS
    .map((id) => AGENTS[id].agentFile)
    .filter((f): f is string => f !== null);

  const seenRealPaths = new Set<string>();
  for (const agentFile of allAgentFiles) {
    const filePath = path.resolve(projectRoot, agentFile);
    if (!fs.existsSync(filePath)) continue;
    const realPath = fs.realpathSync(filePath);
    if (seenRealPaths.has(realPath)) continue;
    seenRealPaths.add(realPath);

    let content = fs.readFileSync(realPath, "utf-8");
    if (content.includes(SNIPPET_MARKER)) {
      // Remove the snippet block (from marker to end of the bullet list)
      content = content.replace(/\n?## TypeScript Navigation \(typegraph-mcp\)\n[\s\S]*?(?=\n## |\n# |$)/, "");
      // Clean up trailing whitespace
      content = content.replace(/\n{3,}$/, "\n");
      fs.writeFileSync(realPath, content);
    }
  }

  // 4. Remove --plugin-dir ./plugins/typegraph-mcp from CLAUDE.md
  const claudeMdPath = path.resolve(projectRoot, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    let content = fs.readFileSync(claudeMdPath, "utf-8");
    content = content.replace(/ --plugin-dir \.\/plugins\/typegraph-mcp/g, "");
    fs.writeFileSync(claudeMdPath, content);
  }

  s.stop("Removed typegraph-mcp");

  // 5. Deregister MCP server from agent config files
  deregisterMcpServers(projectRoot);

  p.outro("typegraph-mcp has been uninstalled from this project.");
}

async function setupAgentInstructions(projectRoot: string, selectedAgents: AgentId[]): Promise<void> {
  // Collect agent instruction files for selected agents
  const agentFiles = selectedAgents
    .map((id) => AGENTS[id].agentFile)
    .filter((f): f is string => f !== null);

  if (agentFiles.length === 0) {
    return; // No agents with instruction files selected (e.g. Cursor only)
  }

  // Find existing files, resolve symlinks to deduplicate
  const seenRealPaths = new Map<string, string>(); // realPath -> first agentFile name
  const existingFiles: { file: string; realPath: string; hasSnippet: boolean }[] = [];
  for (const agentFile of agentFiles) {
    const filePath = path.resolve(projectRoot, agentFile);
    if (!fs.existsSync(filePath)) continue;
    const realPath = fs.realpathSync(filePath);

    const previousFile = seenRealPaths.get(realPath);
    if (previousFile) {
      p.log.info(`${agentFile}: same file as ${previousFile} (skipped)`);
      continue;
    }
    seenRealPaths.set(realPath, agentFile);
    const content = fs.readFileSync(filePath, "utf-8");
    existingFiles.push({ file: agentFile, realPath, hasSnippet: content.includes(SNIPPET_MARKER) });
  }

  if (existingFiles.length === 0) {
    p.log.warn(`No agent instruction files found (${agentFiles.join(", ")})`);
    p.note(AGENT_SNIPPET, "Add this snippet to your agent instructions file");
  } else if (existingFiles.some((f) => f.hasSnippet)) {
    for (const f of existingFiles) {
      if (f.hasSnippet) {
        p.log.info(`${f.file}: already has typegraph-mcp instructions`);
      }
    }
  } else {
    const target = existingFiles[0]!;
    const content = fs.readFileSync(target.realPath, "utf-8");
    const appendContent = (content.endsWith("\n") ? "" : "\n") + "\n" + AGENT_SNIPPET;
    fs.appendFileSync(target.realPath, appendContent);
    p.log.success(`${target.file}: appended typegraph-mcp instructions`);
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
        p.log.success("CLAUDE.md: added --plugin-dir ./plugins/typegraph-mcp");
      } else if (match) {
        p.log.info("CLAUDE.md: --plugin-dir already includes typegraph-mcp");
      }
    }
  }
}

async function runVerification(pluginDir: string, selectedAgents: AgentId[]): Promise<void> {
  const config = resolveConfig(pluginDir);

  console.log("");
  const { main: checkMain } = await import("./check.js");
  const checkResult = await checkMain(config);

  console.log("");

  if (checkResult.failed > 0) {
    p.cancel("Health check has failures — fix the issues above before running smoke tests.");
    process.exit(1);
  }

  const { main: testMain } = await import("./smoke-test.js");
  const testResult = await testMain(config);

  console.log("");

  if (checkResult.failed === 0 && testResult.failed === 0) {
    if (selectedAgents.includes("claude-code")) {
      p.outro("Setup complete! Run: claude --plugin-dir ./plugins/typegraph-mcp\n  Slash commands: /typegraph:check, /typegraph:test, /typegraph:bench");
    } else {
      p.outro("Setup complete! typegraph-mcp tools are now available to your agents.\n  CLI: npx typegraph-mcp check | test | bench");
    }
  } else {
    p.cancel("Setup completed with issues. Fix the failures above and re-run.");
    process.exit(1);
  }
}

// ─── Remove Command (standalone) ─────────────────────────────────────────────

async function remove(yes: boolean): Promise<void> {
  const projectRoot = process.cwd();
  const pluginDir = path.resolve(projectRoot, PLUGIN_DIR_NAME);

  process.stdout.write("\x1Bc");
  p.intro("TypeGraph MCP Remove");

  if (!fs.existsSync(pluginDir)) {
    p.cancel("typegraph-mcp is not installed in this project.");
    process.exit(1);
  }

  if (!yes) {
    const confirmed = await p.confirm({ message: "Remove typegraph-mcp from this project?" });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Removal cancelled.");
      process.exit(0);
    }
  }

  await removePlugin(projectRoot, pluginDir);
}

// ─── Check Command ───────────────────────────────────────────────────────────

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

// ─── Test Command ────────────────────────────────────────────────────────────

async function test(): Promise<void> {
  const config = resolveConfig(resolvePluginDir());
  const { main: testMain } = await import("./smoke-test.js");
  const result = await testMain(config);
  process.exit(result.failed > 0 ? 1 : 0);
}

// ─── Benchmark Command ───────────────────────────────────────────────────────

async function benchmark(): Promise<void> {
  const config = resolveConfig(resolvePluginDir());
  const { main: benchMain } = await import("./benchmark.js");
  await benchMain(config);
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

// Clear npx download noise (warnings, "Ok to proceed?" prompt)
process.stdout.write("\x1Bc");

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
  case "remove":
    remove(yes).catch((err) => {
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
  default:
    console.log(`Unknown command: ${command}`);
    console.log("");
    console.log(HELP);
    process.exit(1);
}
