/**
 * Agents Module
 *
 * AI agent detection and MCP server registration.
 */

export type {
  AgentId,
  AgentDef,
  LegacyGlobalCodexCleanup,
  RemovePluginOptions,
} from "./types.js";

export {
  PLUGIN_DIR_NAME,
  AGENT_IDS,
  AGENTS,
  MCP_SERVER_ENTRY,
  detectAgents,
  getAbsoluteMcpServerEntry,
  isCodexProjectTrusted,
  findLegacyGlobalCodexCleanup,
  removeLegacyGlobalCodexMcp,
  registerJsonMcp,
  deregisterJsonMcp,
  registerCodexMcp,
  deregisterCodexMcp,
  registerOpenCodeMcp,
  deregisterOpenCodeMcp,
  registerMcpServers,
  deregisterMcpServers,
} from "./registry.js";

export {
  removeTomlSectionGroup,
  upsertTomlSection,
  pathEqualsOrContains,
} from "./toml-helpers.js";
