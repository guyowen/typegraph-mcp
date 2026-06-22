/**
 * Server Types
 *
 * Shared types for tool handlers.
 */

import type { TsServerClient, NavBarItem } from "../../tsserver-client.js";
import type { ModuleGraph } from "../../module-graph.js";
import type { ResolverFactory } from "oxc-resolver";

export interface ToolContext {
  client: TsServerClient;
  moduleGraph: ModuleGraph;
  moduleResolver: ResolverFactory;
  projectRoot: string;
  normalizedProjectRoot: string;
  relPath: (absPath: string) => string;
  absPath: (file: string) => string;
  resolveSymbol: (
    file: string,
    symbol: string,
  ) => Promise<{
    file: string;
    line: number;
    column: number;
    kind: string;
    preview: string;
  } | null>;
  readPreview: (file: string, line: number) => string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

export type ToolHandler = (
  params: Record<string, unknown>,
) => Promise<ToolResult>;
