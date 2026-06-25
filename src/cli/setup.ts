#!/usr/bin/env npx tsx
/**
 * typegraph-mcp Setup Command
 *
 * Installs the typegraph-mcp plugin into the current project.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { resolveConfig } from "../shared/config.js";
import {
  ensureTsconfigExclude,
  ensureLintIgnores,
} from "../../tsconfig-patch.js";
import {
  type AgentId,
  AGENT_IDS,
  AGENTS,
  detectAgents,
} from "./agents/index.js";
import {
  removeTomlSectionGroup,
  upsertTomlSection,
  pathEqualsOrContains,
} from "./agents/toml-helpers.js";

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

const PLUGIN_DIR_NAME = "plugins/typegraph-mcp";

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
  "src/core/tsserver/client.ts",
  "src/core/tsserver/index.ts",
  "src/core/tsserver/types.ts",
  "src/shared/config.ts",
  "src/health/checker.ts",
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

const CLAUDE_TEMPLATE_FILES = new Set([
  "commands/check.md",
  "commands/test.md",
  "commands/bench.md",
  "commands/deep-survey.md",
  "skills/deep-survey/SKILL.md",
]);

const SKILL_NAMES = [
  "tool-selection",
  "impact-analysis",
  "refactor-safety",
  "dependency-audit",
  "code-exploration",
  "deep-survey",
];

const MCP_SERVER_ENTRY = {
  command: "npx",
  args: ["tsx", "./plugins/typegraph-mcp/server.ts"],
  env: {
    TYPEGRAPH_PROJECT_ROOT: ".",
    TYPEGRAPH_TSCONFIG: "./tsconfig.json",
  },
};

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

function getAbsoluteMcpServerEntry(projectRoot: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: "npx",
    args: ["tsx", path.resolve(projectRoot, PLUGIN_DIR_NAME, "server.ts")],
    env: {
      TYPEGRAPH_PROJECT_ROOT: projectRoot,
      TYPEGRAPH_TSCONFIG: path.resolve(projectRoot, "tsconfig.json"),
    },
  };
}

function getCodexMcpServerEntry(projectRoot: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: path.resolve(
      projectRoot,
      PLUGIN_DIR_NAME,
      "node_modules/.bin/tsx",
    ),
    args: [path.resolve(projectRoot, PLUGIN_DIR_NAME, "server.ts")],
    env: {
      TYPEGRAPH_PROJECT_ROOT: projectRoot,
      TYPEGRAPH_TSCONFIG: path.resolve(projectRoot, "tsconfig.json"),
    },
  };
}

function getCodexConfigPath(projectRoot: string): string {
  return path.resolve(projectRoot, ".codex/config.toml");
}

function isCodexProjectTrusted(projectRoot: string): boolean {
  const home = process.env.HOME;
  if (!home) return false;

  const globalConfigPath = path.join(home, ".codex/config.toml");
  if (!fs.existsSync(globalConfigPath)) return false;

  const content = fs.readFileSync(globalConfigPath, "utf-8");
  const lines = content.split(/\r?\n/);
  let currentProject: string | null = null;
  let currentTrusted = false;

  const matchesTrustedProject = (): boolean =>
    currentProject !== null &&
    currentTrusted &&
    (projectRoot === currentProject ||
      projectRoot.startsWith(currentProject + path.sep));

  for (const line of lines) {
    const sectionMatch = line.match(/^\[projects\."([^"]+)"\]\s*$/);
    if (sectionMatch) {
      if (matchesTrustedProject()) return true;
      currentProject = path.resolve(sectionMatch[1]!);
      currentTrusted = false;
      continue;
    }

    if (line.startsWith("[")) {
      if (matchesTrustedProject()) return true;
      currentProject = null;
      currentTrusted = false;
      continue;
    }

    if (currentProject && /\btrust_level\s*=\s*"trusted"/.test(line)) {
      currentTrusted = true;
    }
  }

  return matchesTrustedProject();
}

// ─── MCP Registration ─────────────────────────────────────────────────────────

/** Register the typegraph MCP server in agent-specific config files */
function registerMcpServers(
  projectRoot: string,
  selectedAgents: AgentId[],
): void {
  if (selectedAgents.includes("cursor")) {
    registerJsonMcp(projectRoot, ".cursor/mcp.json", "mcpServers");
  }
  if (selectedAgents.includes("codex")) {
    registerCodexMcp(projectRoot);
  }
  if (selectedAgents.includes("copilot")) {
    registerJsonMcp(projectRoot, ".vscode/mcp.json", "servers");
  }
  if (selectedAgents.includes("opencode")) {
    registerAgentJsonMcp(projectRoot, "opencode.json");
  }
  if (selectedAgents.includes("mimocode")) {
    registerAgentJsonMcp(projectRoot, "mimocode.json");
  }
}

/** Register MCP server in a JSON config file (Cursor or Copilot format) */
function registerJsonMcp(
  projectRoot: string,
  configPath: string,
  rootKey: string,
): void {
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

/** Register MCP server in Codex CLI's TOML config */
function registerCodexMcp(projectRoot: string): void {
  const configPath = ".codex/config.toml";
  const fullPath = getCodexConfigPath(projectRoot);
  const absoluteEntry = getCodexMcpServerEntry(projectRoot);
  const args = absoluteEntry.args.map((arg) => `"${arg}"`).join(", ");
  const block = [
    "",
    "[mcp_servers.typegraph]",
    `command = "${absoluteEntry.command}"`,
    `args = [${args}]`,
    `env = { TYPEGRAPH_PROJECT_ROOT = "${absoluteEntry.env.TYPEGRAPH_PROJECT_ROOT}", TYPEGRAPH_TSCONFIG = "${absoluteEntry.env.TYPEGRAPH_TSCONFIG}" }`,
    "",
  ].join("\n");
  let content = "";

  if (fs.existsSync(fullPath)) {
    content = fs.readFileSync(fullPath, "utf-8");
  }

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const { content: nextContent, changed } = upsertTomlSection(
    content,
    "mcp_servers.typegraph",
    block,
  );
  if (changed) {
    fs.writeFileSync(fullPath, nextContent);
    p.log.success(`${configPath}: registered typegraph MCP server`);
  } else {
    p.log.info(`${configPath}: typegraph MCP server already registered`);
  }

  if (!isCodexProjectTrusted(projectRoot)) {
    p.log.info(
      `Codex CLI: trust ${projectRoot} in ~/.codex/config.toml to load project MCP settings`,
    );
  }
}

/** Register typegraph MCP server in an agent's JSON config file */
export function registerAgentJsonMcp(
  projectRoot: string,
  configPath: string,
): void {
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

  const mcp = (config["mcp"] as Record<string, unknown>) ?? {};
  const serverPath = path.resolve(projectRoot, PLUGIN_DIR_NAME, "server.ts");
  const tsxPath = path.resolve(
    projectRoot,
    PLUGIN_DIR_NAME,
    "node_modules/.bin/tsx",
  );

  mcp["typegraph"] = {
    type: "local",
    command: [tsxPath, serverPath],
    environment: {
      TYPEGRAPH_PROJECT_ROOT: projectRoot,
      TYPEGRAPH_TSCONFIG: path.resolve(projectRoot, "tsconfig.json"),
    },
  };
  config["mcp"] = mcp;

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, JSON.stringify(config, null, 2) + "\n");
  p.log.success(`${configPath}: registered typegraph MCP server`);
}

// ─── Agent Selection ─────────────────────────────────────────────────────────

async function selectAgents(
  projectRoot: string,
  yes: boolean,
): Promise<AgentId[]> {
  const detected = detectAgents(projectRoot, AGENT_IDS, AGENTS);

  if (yes) {
    const selected = detected.length > 0 ? detected : [...AGENT_IDS];
    p.log.info(
      `Auto-selected: ${selected.map((id) => AGENTS[id].name).join(", ")}`,
    );
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

  const selected =
    (result as AgentId[]).length > 0
      ? (result as AgentId[])
      : detected.length > 0
        ? detected
        : [...AGENT_IDS];

  p.log.info(`Selected: ${selected.map((id) => AGENTS[id].name).join(", ")}`);

  return selected;
}

// ─── Setup Command ───────────────────────────────────────────────────────────

export async function setup(yes: boolean): Promise<void> {
  // setup.ts lives in src/cli/, so repo root is two levels up
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const sourceDir =
    path.basename(repoRoot) === "dist"
      ? path.resolve(repoRoot, "..")
      : repoRoot;
  const projectRoot = process.cwd();

  process.stdout.write("\x1Bc"); // Clear terminal
  p.intro("TypeGraph MCP Setup");

  p.log.info(`Project: ${projectRoot}`);

  // 1. Validate project
  const pkgJsonPath = path.resolve(projectRoot, "package.json");
  const tsconfigPath = path.resolve(projectRoot, "tsconfig.json");

  if (!fs.existsSync(pkgJsonPath)) {
    p.cancel(
      "No package.json found. Run this from the root of your TypeScript project.",
    );
    process.exit(1);
  }

  if (!fs.existsSync(tsconfigPath)) {
    p.cancel(
      "No tsconfig.json found. typegraph-mcp requires a TypeScript project.",
    );
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
        {
          value: "remove",
          label: "Remove",
          hint: "uninstall typegraph-mcp from this project",
        },
        { value: "exit", label: "Exit", hint: "keep existing installation" },
      ],
    });

    if (p.isCancel(action)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (action === "remove") {
      const { removePlugin } = await import("./remove.js");
      const removeOptions = await resolveRemovePluginOptions(
        projectRoot,
        false,
        false,
      );
      await removePlugin(projectRoot, targetDir, removeOptions);
      if (removeOptions.warnAboutGlobalCodex) {
        warnAboutStaleGlobalCodex();
      }
      return;
    }

    if (action === "exit") {
      p.outro("No changes made.");
      return;
    }
  }

  // 3. Agent selection
  const selectedAgents = await selectAgents(projectRoot, yes);

  const needsPluginSkills =
    selectedAgents.includes("claude-code") || selectedAgents.includes("cursor");
  const needsAgentsSkills = selectedAgents.some(
    (id) => AGENTS[id].needsAgentsSkills,
  );

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
      if (
        selectedAgents.includes("claude-code") &&
        CLAUDE_TEMPLATE_FILES.has(file)
      ) {
        const content = fs
          .readFileSync(src, "utf-8")
          .replaceAll(CLAUDE_NODE_PLACEHOLDER, process.execPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
      } else {
        copyFile(src, dest);
      }
      copied++;
    } else {
      p.log.warn(`Source file not found: ${file}`);
    }
  }

  // Generate .mcp.json for Claude Code plugin discovery
  if (selectedAgents.includes("claude-code")) {
    const mcpConfig = {
      mcpServers: {
        typegraph: {
          command: process.execPath,
          args: [
            "${CLAUDE_PLUGIN_ROOT}/node_modules/tsx/dist/cli.mjs",
            "${CLAUDE_PLUGIN_ROOT}/server.ts",
          ],
          env: {
            TYPEGRAPH_PROJECT_ROOT: ".",
            TYPEGRAPH_TSCONFIG: "./tsconfig.json",
          },
        },
      },
    };
    const mcpPath = path.join(targetDir, ".mcp.json");
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    copied++;
  }

  s.message("Installing dependencies...");
  try {
    execSync("npm install --include=optional", {
      cwd: targetDir,
      stdio: "pipe",
    });
    s.stop(
      `${isUpdate ? "Updated" : "Installed"} ${copied} files with dependencies`,
    );
  } catch (err) {
    s.stop(`${isUpdate ? "Updated" : "Installed"} ${copied} files`);
    p.log.warn(
      `Dependency install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    p.log.info(
      `Run manually: cd ${PLUGIN_DIR_NAME} && npm install --include=optional`,
    );
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
      p.log.success(
        `Copied ${copiedSkills} skills to .agents/skills/ (${agentsNames.join(", ")})`,
      );
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
          fs.writeFileSync(
            mcpJsonPath,
            JSON.stringify(mcpJson, null, 2) + "\n",
          );
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
  ensureTsconfigExclude(projectRoot, p.log);

  // 9. Ensure plugins/ is ignored by supported lint configs
  ensureLintIgnores(projectRoot, p.log);

  // 10. Verification
  await runVerification(targetDir, selectedAgents);
}

// ─── Agent Instructions ──────────────────────────────────────────────────────

async function setupAgentInstructions(
  projectRoot: string,
  selectedAgents: AgentId[],
): Promise<void> {
  // Collect agent instruction files for selected agents
  const agentFiles = selectedAgents
    .map((id) => AGENTS[id].agentFile)
    .filter((f): f is string => f !== null);

  if (agentFiles.length === 0) {
    return; // No agents with instruction files selected (e.g. Cursor only)
  }

  // Ensure each selected agent file exists and has the snippet once. Resolve
  // symlinks to avoid writing duplicate content through multiple aliases.
  const seenRealPaths = new Map<string, string>(); // realPath -> first agentFile name
  for (const agentFile of agentFiles) {
    const filePath = path.resolve(projectRoot, agentFile);
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, AGENT_SNIPPET + "\n");
      p.log.success(`${agentFile}: created with typegraph-mcp instructions`);
      continue;
    }

    const realPath = fs.realpathSync(filePath);
    const previousFile = seenRealPaths.get(realPath);
    if (previousFile) {
      p.log.info(`${agentFile}: same file as ${previousFile} (skipped)`);
      continue;
    }

    seenRealPaths.set(realPath, agentFile);
    const content = fs.readFileSync(realPath, "utf-8");
    if (content.includes(SNIPPET_MARKER)) {
      p.log.info(`${agentFile}: already has typegraph-mcp instructions`);
      continue;
    }

    const appendContent =
      (content.endsWith("\n") ? "" : "\n") + "\n" + AGENT_SNIPPET;
    fs.appendFileSync(realPath, appendContent);
    p.log.success(`${agentFile}: appended typegraph-mcp instructions`);
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
          `$1${existingFlags} --plugin-dir ./plugins/typegraph-mcp$3`,
        );
        fs.writeFileSync(claudeMdPath, content);
        p.log.success("CLAUDE.md: added --plugin-dir ./plugins/typegraph-mcp");
      } else if (match) {
        p.log.info("CLAUDE.md: --plugin-dir already includes typegraph-mcp");
      }
    }
  }
}

async function runVerification(
  pluginDir: string,
  selectedAgents: AgentId[],
): Promise<void> {
  const config = resolveConfig(pluginDir);

  console.log("");
  const { main: checkMain } = await import("../health/checker.js");
  const checkResult = await checkMain(config);

  console.log("");

  if (checkResult.failed > 0) {
    p.cancel(
      "Health check has failures — fix the issues above before running smoke tests.",
    );
    process.exit(1);
  }

  const { main: testMain } = await import("../../smoke-test.js");
  const testResult = await testMain(config);

  console.log("");

  if (checkResult.failed === 0 && testResult.failed === 0) {
    if (selectedAgents.includes("claude-code")) {
      p.outro(
        "Setup complete! Run: claude --plugin-dir ./plugins/typegraph-mcp\n  Slash commands: /typegraph:check, /typegraph:test, /typegraph:bench, /typegraph:deep-survey",
      );
    } else {
      p.outro(
        "Setup complete! typegraph-mcp tools are now available to your agents.\n  CLI: npx typegraph-mcp check | test | bench",
      );
    }
  } else {
    p.cancel("Setup completed with issues. Fix the failures above and re-run.");
    process.exit(1);
  }
}

// ─── Remove Options ──────────────────────────────────────────────────────────

export interface RemovePluginOptions {
  removeGlobalCodex: boolean;
  legacyGlobalCodexCleanup: LegacyGlobalCodexCleanup | null;
  warnAboutGlobalCodex: boolean;
}

interface LegacyGlobalCodexCleanup {
  globalConfigPath: string;
  nextContent: string;
}

export async function resolveRemovePluginOptions(
  projectRoot: string,
  yes: boolean,
  cleanGlobalCodex: boolean,
): Promise<RemovePluginOptions> {
  const legacyGlobalCodexCleanup = findLegacyGlobalCodexCleanup(projectRoot);
  let removeGlobalCodex = cleanGlobalCodex;

  if (legacyGlobalCodexCleanup && !cleanGlobalCodex && !yes) {
    const shouldRemoveGlobal = await p.confirm({
      message:
        "Also remove the stale global Codex MCP entry for this project from ~/.codex/config.toml?",
      initialValue: false,
    });
    if (p.isCancel(shouldRemoveGlobal)) {
      p.cancel("Removal cancelled.");
      process.exit(0);
    }
    removeGlobalCodex = shouldRemoveGlobal;
  }

  return {
    removeGlobalCodex,
    legacyGlobalCodexCleanup,
    warnAboutGlobalCodex:
      legacyGlobalCodexCleanup !== null && !removeGlobalCodex,
  };
}

function findLegacyGlobalCodexCleanup(
  projectRoot: string,
): LegacyGlobalCodexCleanup | null {
  const home = process.env.HOME;
  if (!home) return null;

  const globalConfigPath = path.join(home, ".codex/config.toml");
  if (!fs.existsSync(globalConfigPath)) return null;

  const content = fs.readFileSync(globalConfigPath, "utf-8");
  const {
    content: nextContent,
    removed,
    removedContent,
  } = removeTomlSectionGroup(content, "mcp_servers.typegraph");
  if (!removed) return null;

  const pluginRoot = path.resolve(projectRoot, PLUGIN_DIR_NAME);
  const quotedPaths = Array.from(
    removedContent.matchAll(/"([^"\n]+)"/g),
    (match) => match[1]!,
  );
  const looksProjectSpecific = quotedPaths.some(
    (quotedPath) =>
      pathEqualsOrContains(quotedPath, projectRoot) ||
      pathEqualsOrContains(quotedPath, pluginRoot),
  );

  if (!looksProjectSpecific) {
    return null;
  }

  return { globalConfigPath, nextContent };
}

function removeLegacyGlobalCodexMcp(cleanup: LegacyGlobalCodexCleanup): void {
  if (cleanup.nextContent === "") {
    fs.unlinkSync(cleanup.globalConfigPath);
  } else {
    fs.writeFileSync(cleanup.globalConfigPath, cleanup.nextContent);
  }

  p.log.info(
    "~/.codex/config.toml: removed stale global typegraph MCP server entry for this project",
  );
}

function warnAboutStaleGlobalCodex(): void {
  p.log.warn(
    "Left a stale global Codex MCP entry for this project in ~/.codex/config.toml. " +
      "Codex may show MCP startup warnings or errors until you remove it. " +
      "Re-run `typegraph-mcp remove --clean-global-codex` or remove the `typegraph` block manually.",
  );
}
