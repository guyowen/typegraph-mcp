/**
 * Agent Types
 *
 * Type definitions for AI agent support.
 * Extracted from cli.ts for reusability.
 */

export type AgentId =
  | "claude-code"
  | "cursor"
  | "codex"
  | "gemini"
  | "copilot"
  | "opencode"
  | "mimocode";

export interface AgentDef {
  name: string;
  pluginFiles: string[];
  agentFile: string | null;
  needsAgentsSkills: boolean;
  detect: (projectRoot: string) => boolean;
}

export interface LegacyGlobalCodexCleanup {
  globalConfigPath: string;
  nextContent: string;
}

export interface RemovePluginOptions {
  removeGlobalCodex: boolean;
  legacyGlobalCodexCleanup: LegacyGlobalCodexCleanup | null;
  warnAboutGlobalCodex: boolean;
}
