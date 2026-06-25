/**
 * Tsserver Module
 *
 * TypeScript Server Protocol types + client for semantic code analysis.
 */

export type {
  Location,
  DefinitionResult,
  ReferenceEntry,
  QuickInfoResult,
  NavToItem,
  NavBarItem,
  PendingRequest,
  TsServerMessage,
} from "./types.js";

export { TsServerClient } from "./client.js";
