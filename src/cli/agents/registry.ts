/**
 * Agent Registry
 *
 * Agent detection and MCP server registration.
 * Extracted from cli.ts for modularity.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentId, AgentDef } from "./types.js";
import {
  removeTomlSectionGroup,
  pathEqualsOrContains,
} from "./toml-helpers.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const PLUGIN_DIR_NAME = "plugins/typegraph-mcp";

export const MCP_SERVER_ENTRY = {
  command: "npx",
  args: ["tsx", "./plugins/typegraph-mcp/server.ts"],
  env: {
    TYPEGRAPH_PROJECT_ROOT: ".",
    TYPEGRAPH_TSCONFIG: "./tsconfig.json",
  },
};

// ─── Agent Detection ─────────────────────────────────────────────────────────

/**
 * Detect which AI agents are configured in the project.
 */
export function detectAgents(
  projectRoot: string,
  agentIds: readonly AgentId[],
  agents: Record<AgentId, AgentDef>,
): AgentId[] {
  return agentIds.filter((id) => agents[id].detect(projectRoot));
}

// ─── Path Helpers ────────────────────────────────────────────────────────────

export function getAbsoluteMcpServerEntry(projectRoot: string): {
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

// ─── Codex MCP ───────────────────────────────────────────────────────────────

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

function makeCodexMcpBlock(projectRoot: string): string {
  const absoluteEntry = getCodexMcpServerEntry(projectRoot);
  const args = absoluteEntry.args.map((arg) => `"${arg}"`).join(", ");
  return [
    "",
    "[mcp_servers.typegraph]",
    `command = "${absoluteEntry.command}"`,
    `args = [${args}]`,
    `env = { TYPEGRAPH_PROJECT_ROOT = "${absoluteEntry.env.TYPEGRAPH_PROJECT_ROOT}", TYPEGRAPH_TSCONFIG = "${absoluteEntry.env.TYPEGRAPH_TSCONFIG}" }`,
    "",
  ].join("\n");
}

export function isCodexProjectTrusted(projectRoot: string): boolean {
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

export function findLegacyGlobalCodexCleanup(
  projectRoot: string,
): { globalConfigPath: string; nextContent: string } | null {
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

export function removeLegacyGlobalCodexMcp(cleanup: {
  globalConfigPath: string;
  nextContent: string;
}): void {
  if (cleanup.nextContent === "") {
    fs.unlinkSync(cleanup.globalConfigPath);
  } else {
    fs.writeFileSync(cleanup.globalConfigPath, cleanup.nextContent);
  }
}

// ─── JSON MCP Registration ───────────────────────────────────────────────────

export function registerJsonMcp(
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
      console.error(
        `Could not parse ${configPath} — skipping MCP registration`,
      );
      return;
    }
  }

  const servers = (config[rootKey] as Record<string, unknown>) ?? {};
  const entry: Record<string, unknown> = { ...MCP_SERVER_ENTRY };
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
  console.error(`${configPath}: registered typegraph MCP server`);
}

export function deregisterJsonMcp(
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

    if (Object.keys(servers).length === 0) {
      delete config[rootKey];
    }

    if (Object.keys(config).length === 0) {
      fs.unlinkSync(fullPath);
    } else {
      fs.writeFileSync(fullPath, JSON.stringify(config, null, 2) + "\n");
    }
    console.error(`${configPath}: removed typegraph MCP server`);
  } catch {
    // Ignore parse errors
  }
}

// ─── Codex MCP Registration ──────────────────────────────────────────────────

export function registerCodexMcp(projectRoot: string): void {
  const configPath = ".codex/config.toml";
  const fullPath = getCodexConfigPath(projectRoot);
  const block = makeCodexMcpBlock(projectRoot);
  let content = "";

  if (fs.existsSync(fullPath)) {
    content = fs.readFileSync(fullPath, "utf-8");
  }

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sectionRe = /\n?\[mcp_servers\.typegraph\]\n[\s\S]*?(?=\n\[|$)/;
  const normalizedBlock = block.trim();

  if (sectionRe.test(content)) {
    const existingSection = (content.match(sectionRe)?.[0] ?? "").trim();
    if (existingSection !== normalizedBlock) {
      content =
        content.replace(sectionRe, `\n${normalizedBlock}\n`).trimEnd() + "\n";
      fs.writeFileSync(fullPath, content);
      console.error(`${configPath}: registered typegraph MCP server`);
    } else {
      console.error(`${configPath}: typegraph MCP server already registered`);
    }
  } else {
    content = content.trimEnd() + "\n\n" + normalizedBlock + "\n";
    fs.writeFileSync(fullPath, content);
    console.error(`${configPath}: registered typegraph MCP server`);
  }

  if (!isCodexProjectTrusted(projectRoot)) {
    console.error(
      `Codex CLI: trust ${projectRoot} in ~/.codex/config.toml to load project MCP settings`,
    );
  }
}

export function deregisterCodexMcp(projectRoot: string): void {
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
      console.error(`${configPath}: removed typegraph MCP server`);
    }
  }
}

// ─── OpenCode MCP Registration ───────────────────────────────────────────────

export function registerOpenCodeMcp(projectRoot: string): void {
  const configPath = "opencode.json";
  const fullPath = path.resolve(projectRoot, configPath);
  let config: Record<string, unknown> = {};

  if (fs.existsSync(fullPath)) {
    try {
      config = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    } catch {
      console.error(
        `Could not parse ${configPath} — skipping MCP registration`,
      );
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
  console.error(`${configPath}: registered typegraph MCP server`);
}

export function deregisterOpenCodeMcp(projectRoot: string): void {
  const configPath = "opencode.json";
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
    console.error(`${configPath}: removed typegraph MCP server`);
  } catch {
    // Ignore parse errors
  }
}

// ─── Composite Registration ──────────────────────────────────────────────────

export function registerMcpServers(
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
    registerOpenCodeMcp(projectRoot);
  }
}

export function deregisterMcpServers(projectRoot: string): void {
  deregisterJsonMcp(projectRoot, ".cursor/mcp.json", "mcpServers");
  deregisterCodexMcp(projectRoot);
  deregisterJsonMcp(projectRoot, ".vscode/mcp.json", "servers");
  deregisterOpenCodeMcp(projectRoot);
}
