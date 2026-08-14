/**
 * Provider registry: where each agent discovers skills, and how its MCP server
 * entry is written.
 *
 * There is no plugin directory. Every agent here discovers skills from a
 * directory it already owns and finds the MCP server through its own config
 * file, so nothing is copied into the target project except SKILL.md files.
 *
 * `skillsReadsFrom` is a list rather than a single destination because several
 * agents read more than one location — that flexibility is what lets
 * computeSkillTargets() collapse a multi-agent install down to one directory
 * instead of writing the same skill somewhere each agent would find it twice.
 */
import fs from "node:fs";
import path from "node:path";

export type AgentId =
  | "claude-code"
  | "cursor"
  | "codex"
  | "gemini"
  | "copilot"
  | "antigravity"
  | "opencode";

/** Where SKILL.md files can be written. All project-relative. */
export type SkillsDir = "claude" | "agents" | "cursor";

export const SKILLS_DIR_PATHS: Record<SkillsDir, string> = {
  claude: ".claude/skills",
  agents: ".agents/skills",
  cursor: ".cursor/skills",
};

export const SKILLS_DIRS = Object.keys(SKILLS_DIR_PATHS) as SkillsDir[];

/** Entry shape written into a JSON MCP config. */
export type McpEntryShape =
  /** { command, args } — Claude Code / Cursor */
  | "command-args"
  /** { command, args, type: "stdio" } — Copilot / VS Code */
  | "command-args-stdio"
  /** { type: "local", command: [cmd, ...args], enabled } — OpenCode */
  | "opencode";

export type McpRegistration =
  | { kind: "none" }
  | { kind: "json"; file: string; rootKey: string; shape: McpEntryShape }
  | { kind: "codex-toml" };

export interface AgentDef {
  name: string;
  /** Instruction file to receive the usage snippet, if any. */
  agentFile: string | null;
  /**
   * Skill directories this agent can discover from, in preference order.
   * Multiple entries mean the agent is flexible and can be satisfied by
   * whichever directory another selected agent already forces us to write.
   */
  skillsReadsFrom: SkillsDir[];
  mcp: McpRegistration;
  detect: (projectRoot: string) => boolean;
}

const exists = (root: string, ...rel: string[]): boolean =>
  rel.some((r) => fs.existsSync(path.join(root, r)));

export const AGENT_IDS: AgentId[] = [
  "claude-code",
  "cursor",
  "codex",
  "gemini",
  "copilot",
  "antigravity",
  "opencode",
];

export const AGENTS: Record<AgentId, AgentDef> = {
  "claude-code": {
    name: "Claude Code",
    agentFile: "CLAUDE.md",
    skillsReadsFrom: ["claude"],
    mcp: {
      kind: "json",
      file: ".mcp.json",
      rootKey: "mcpServers",
      shape: "command-args",
    },
    detect: (root) => exists(root, "CLAUDE.md", ".claude"),
  },
  cursor: {
    name: "Cursor",
    agentFile: null,
    // Cursor reads .cursor/skills/ natively and also loads .agents/skills/ and
    // .claude/skills/ for cross-tool compatibility. Listing all three lets it
    // ride along with another agent's directory instead of forcing a third.
    skillsReadsFrom: ["cursor", "claude", "agents"],
    mcp: {
      kind: "json",
      file: ".cursor/mcp.json",
      rootKey: "mcpServers",
      shape: "command-args",
    },
    detect: (root) => exists(root, ".cursor"),
  },
  codex: {
    name: "Codex CLI",
    agentFile: "AGENTS.md",
    skillsReadsFrom: ["agents"],
    mcp: { kind: "codex-toml" },
    detect: (root) => exists(root, "AGENTS.md", ".codex"),
  },
  gemini: {
    name: "Gemini CLI",
    agentFile: "GEMINI.md",
    skillsReadsFrom: ["agents"],
    mcp: { kind: "none" },
    detect: (root) => exists(root, "GEMINI.md"),
  },
  copilot: {
    name: "GitHub Copilot",
    agentFile: ".github/copilot-instructions.md",
    skillsReadsFrom: ["agents"],
    mcp: {
      kind: "json",
      file: ".vscode/mcp.json",
      rootKey: "servers",
      shape: "command-args-stdio",
    },
    detect: (root) => exists(root, ".github/copilot-instructions.md"),
  },
  antigravity: {
    name: "Antigravity",
    agentFile: "AGENTS.md",
    skillsReadsFrom: ["agents"],
    mcp: {
      kind: "json",
      file: ".agents/mcp_config.json",
      rootKey: "mcpServers",
      shape: "command-args",
    },
    detect: (root) => exists(root, "AGENTS.md", ".agents", ".gemini"),
  },
  opencode: {
    name: "OpenCode",
    agentFile: "AGENTS.md",
    // OpenCode discovers from .opencode/skills/, .claude/skills/ AND
    // .agents/skills/. Listing both means it rides along with whatever another
    // selected agent already forces, instead of duplicating skills into a
    // second directory that OpenCode would then read twice.
    skillsReadsFrom: ["claude", "agents"],
    mcp: {
      kind: "json",
      file: "opencode.json",
      rootKey: "mcp",
      shape: "opencode",
    },
    detect: (root) => exists(root, "opencode.json", "opencode.jsonc", ".opencode"),
  },
};

/**
 * Minimal set of skill directories covering every selected agent.
 *
 * Agents with a single option force their directory. Flexible agents (Cursor
 * and OpenCode) are satisfied by an already-forced directory when possible, and
 * only add one when nothing they can read is being written. Without this,
 * selecting OpenCode + Codex would write skills to BOTH .claude/skills/ and
 * .agents/skills/, and OpenCode — which reads both — would see every skill twice.
 */
export function computeSkillTargets(selected: readonly AgentId[]): SkillsDir[] {
  const targets = new Set<SkillsDir>();

  for (const id of selected) {
    const reads = AGENTS[id].skillsReadsFrom;
    if (reads.length === 1) targets.add(reads[0]!);
  }
  for (const id of selected) {
    const reads = AGENTS[id].skillsReadsFrom;
    if (reads.length <= 1) continue;
    if (reads.some((d) => targets.has(d))) continue;
    targets.add(reads[0]!);
  }
  return [...targets];
}

/** Agents whose skills are served by a given directory — for install logging. */
export function agentsServedBy(selected: readonly AgentId[], dir: SkillsDir): string[] {
  const targets = computeSkillTargets(selected);
  return selected
    .filter((id) => {
      const reads = AGENTS[id].skillsReadsFrom;
      if (!reads.includes(dir)) return false;
      // A flexible agent is attributed to its first target actually written.
      return reads.find((d) => targets.includes(d)) === dir;
    })
    .map((id) => AGENTS[id].name);
}

/** Every project-scoped JSON MCP config we know how to write, for `check`. */
export function projectJsonMcpConfigs(): Array<{ file: string; rootKey: string }> {
  const seen = new Map<string, { file: string; rootKey: string }>();
  for (const id of AGENT_IDS) {
    const reg = AGENTS[id].mcp;
    if (reg.kind === "json") {
      seen.set(reg.file, { file: reg.file, rootKey: reg.rootKey });
    }
  }
  return [...seen.values()];
}

export interface McpCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Build the provider-specific JSON entry for an MCP server. */
export function buildMcpEntry(shape: McpEntryShape, cmd: McpCommand): Record<string, unknown> {
  switch (shape) {
    case "command-args":
      return { command: cmd.command, args: cmd.args, ...(cmd.env ? { env: cmd.env } : {}) };
    case "command-args-stdio":
      return {
        type: "stdio",
        command: cmd.command,
        args: cmd.args,
        ...(cmd.env ? { env: cmd.env } : {}),
      };
    case "opencode":
      // OpenCode collapses command+args into ONE array and requires type/enabled.
      return {
        type: "local",
        command: [cmd.command, ...cmd.args],
        enabled: true,
        ...(cmd.env ? { environment: cmd.env } : {}),
      };
  }
}
