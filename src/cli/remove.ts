#!/usr/bin/env npx tsx
/**
 * typegraph-mcp Remove Command
 *
 * Uninstalls the typegraph-mcp plugin from the current project.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";
import { type AgentId, AGENT_IDS, AGENTS } from "./agents/index.js";
import {
  removeTomlSectionGroup,
  pathEqualsOrContains,
} from "./agents/toml-helpers.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const PLUGIN_DIR_NAME = "plugins/typegraph-mcp";

const SNIPPET_MARKER = "## TypeScript Navigation (typegraph-mcp)";
const CLAUDE_NODE_PLACEHOLDER = "__TYPEGRAPH_NODE__";

const SKILL_NAMES = [
  "tool-selection",
  "impact-analysis",
  "refactor-safety",
  "dependency-audit",
  "code-exploration",
  "deep-survey",
];

function getCodexConfigPath(projectRoot: string): string {
  return path.resolve(projectRoot, ".codex/config.toml");
}

// ─── MCP Deregistration ───────────────────────────────────────────────────────

/** Deregister the typegraph MCP server from all agent config files */
export function deregisterMcpServers(projectRoot: string): void {
  deregisterJsonMcp(projectRoot, ".cursor/mcp.json", "mcpServers");
  deregisterCodexMcp(projectRoot);
  deregisterJsonMcp(projectRoot, ".vscode/mcp.json", "servers");
  deregisterAgentJsonMcp(projectRoot, "opencode.json");
  deregisterAgentJsonMcp(projectRoot, "mimocode.json");
}

/** Deregister MCP server from a JSON config file */
function deregisterJsonMcp(
  projectRoot: string,
  configPath: string,
  rootKey: string,
): void {
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

/** Deregister MCP server from Codex CLI's TOML config */
function deregisterCodexMcp(projectRoot: string): void {
  const configPath = ".codex/config.toml";
  const fullPath = getCodexConfigPath(projectRoot);
  if (fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath, "utf-8");
    const { content: nextContent, removed } = removeTomlSectionGroup(
      content,
      "mcp_servers.typegraph",
    );

    if (removed) {
      if (nextContent === "") {
        fs.unlinkSync(fullPath);
      } else {
        fs.writeFileSync(fullPath, nextContent);
      }
      p.log.info(`${configPath}: removed typegraph MCP server`);
    }
  }
}

/** Deregister typegraph MCP server from an agent's JSON config file */
export function deregisterAgentJsonMcp(
  projectRoot: string,
  configPath: string,
): void {
  const fullPath = path.resolve(projectRoot, configPath);
  if (!fs.existsSync(fullPath)) return;

  try {
    const config = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    const mcp = config["mcp"];
    if (!mcp || !mcp["typegraph"]) return;

    delete mcp["typegraph"];

    if (Object.keys(mcp).length === 0) {
      delete config["mcp"];
    }

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

// ─── Legacy Global Codex Cleanup ─────────────────────────────────────────────

interface LegacyGlobalCodexCleanup {
  globalConfigPath: string;
  nextContent: string;
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

// ─── Remove Options ──────────────────────────────────────────────────────────

export interface RemovePluginOptions {
  removeGlobalCodex: boolean;
  legacyGlobalCodexCleanup: LegacyGlobalCodexCleanup | null;
  warnAboutGlobalCodex: boolean;
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

// ─── Remove Command ──────────────────────────────────────────────────────────

export async function removePlugin(
  projectRoot: string,
  pluginDir: string,
  options: RemovePluginOptions,
): Promise<void> {
  const s = p.spinner();
  s.start("Removing typegraph-mcp...");

  // 1. Deregister MCP server from agent config files while project paths still exist
  deregisterMcpServers(projectRoot);
  if (options.removeGlobalCodex && options.legacyGlobalCodexCleanup) {
    removeLegacyGlobalCodexMcp(options.legacyGlobalCodexCleanup);
  }

  // 2. Remove plugin directory
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true });
  }

  // 3. Remove .agents/skills/ entries (only typegraph-mcp skills, not the whole dir)
  const agentsSkillsDir = path.resolve(projectRoot, ".agents/skills");
  for (const skill of SKILL_NAMES) {
    const skillDir = path.join(agentsSkillsDir, skill);
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true });
    }
  }
  // Clean up .agents/skills/ and .agents/ if empty
  if (
    fs.existsSync(agentsSkillsDir) &&
    fs.readdirSync(agentsSkillsDir).length === 0
  ) {
    fs.rmSync(agentsSkillsDir, { recursive: true });
    const agentsDir = path.resolve(projectRoot, ".agents");
    if (fs.existsSync(agentsDir) && fs.readdirSync(agentsDir).length === 0) {
      fs.rmSync(agentsDir, { recursive: true });
    }
  }

  // 4. Remove agent instruction snippet from all known agent files
  const allAgentFiles = AGENT_IDS.map((id) => AGENTS[id].agentFile).filter(
    (f): f is string => f !== null,
  );

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
      content = content.replace(
        /\n?## TypeScript Navigation \(typegraph-mcp\)\n[\s\S]*?(?=\n## |\n# |$)/,
        "",
      );
      // Clean up trailing whitespace
      content = content.replace(/\n{3,}$/, "\n");
      fs.writeFileSync(realPath, content);
    }
  }

  // 5. Remove --plugin-dir ./plugins/typegraph-mcp from CLAUDE.md
  const claudeMdPath = path.resolve(projectRoot, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    let content = fs.readFileSync(claudeMdPath, "utf-8");
    content = content.replace(/ --plugin-dir \.\/plugins\/typegraph-mcp/g, "");
    fs.writeFileSync(claudeMdPath, content);
  }

  s.stop("Removed typegraph-mcp");

  p.outro("typegraph-mcp has been uninstalled from this project.");
}

export async function remove(yes: boolean): Promise<void> {
  const projectRoot = process.cwd();
  const pluginDir = path.resolve(projectRoot, PLUGIN_DIR_NAME);
  const cleanGlobalCodex = process.argv.includes("--clean-global-codex");

  process.stdout.write("\x1Bc");
  p.intro("TypeGraph MCP Remove");

  if (!fs.existsSync(pluginDir)) {
    p.cancel("typegraph-mcp is not installed in this project.");
    process.exit(1);
  }

  if (!yes) {
    const confirmed = await p.confirm({
      message: "Remove typegraph-mcp from this project?",
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Removal cancelled.");
      process.exit(0);
    }
  }

  const removeOptions = await resolveRemovePluginOptions(
    projectRoot,
    yes,
    cleanGlobalCodex,
  );
  await removePlugin(projectRoot, pluginDir, removeOptions);

  if (removeOptions.warnAboutGlobalCodex) {
    warnAboutStaleGlobalCodex();
  }
}
