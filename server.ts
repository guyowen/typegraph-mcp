#!/usr/bin/env npx tsx
/**
 * TypeGraph MCP Server — Type-aware codebase navigation for AI coding agents.
 *
 * Bridges MCP protocol (stdin/stdout) to tsserver (child process pipes).
 * Provides 14 tools for definition, references, type info, symbol search,
 * call chain tracing, blast radius analysis, module export inspection,
 * and module graph queries (dependency trees, cycles, paths, boundaries).
 *
 * Usage:
 *   npx tsx server.ts
 *
 * Environment:
 *   TYPEGRAPH_PROJECT_ROOT  — project root (default: cwd)
 *   TYPEGRAPH_TSCONFIG      — tsconfig path (default: ./tsconfig.json)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ResolverFactory } from "oxc-resolver";
import { TsServerClient, type NavBarItem } from "./src/core/tsserver/index.js";
import {
  buildGraph,
  startWatcher,
  type ModuleGraph,
  type ImportEdge,
} from "./src/core/graph/index.js";
import {
  loadDiskCache,
  validateDiskCache,
  saveDiskCache,
  updateCacheEntry,
  removeCacheEntry,
} from "./disk-cache.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfig } from "./src/shared/config.js";
import {
  type ToolContext,
  navigationTools,
  graphTools,
} from "./src/server/index.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const { projectRoot, tsconfigPath } = resolveConfig(import.meta.dirname);

const log = (...args: unknown[]) => console.error("[typegraph]", ...args);

// ─── Initialize ──────────────────────────────────────────────────────────────

const client = new TsServerClient(projectRoot, tsconfigPath);

// Module graph — initialized in main(), used by graph tools
let moduleGraph: ModuleGraph;
let moduleResolver: ResolverFactory;

const mcpServer = new McpServer({
  name: "typegraph",
  version: "1.0.0",
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read a preview line from a file at a 1-based line number */
const previewCache = new Map<string, { lines: string[]; mtime: number }>();
const PREVIEW_CACHE_MAX = 500;

function readPreview(file: string, line: number): string {
  try {
    const absPath = client.resolvePath(file);
    const stat = fs.statSync(absPath);
    const cached = previewCache.get(absPath);

    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.lines[line - 1]?.trim() ?? "";
    }

    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split("\n");

    if (previewCache.size >= PREVIEW_CACHE_MAX) {
      const firstKey = previewCache.keys().next().value;
      if (firstKey) previewCache.delete(firstKey);
    }
    previewCache.set(absPath, { lines, mtime: stat.mtimeMs });

    return lines[line - 1]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Search a navbar tree recursively for a symbol by name */
function findInNavBar(
  items: NavBarItem[],
  symbol: string,
): { line: number; offset: number; kind: string } | null {
  for (const item of items) {
    if (item.text === symbol && item.spans.length > 0) {
      const span = item.spans[0]!;
      return {
        line: span.start.line,
        offset: span.start.offset,
        kind: item.kind,
      };
    }
    if (item.childItems?.length > 0) {
      const found = findInNavBar(item.childItems, symbol);
      if (found) return found;
    }
  }
  return null;
}

/** Resolve symbol to coordinates: try navbar first, fall back to navto */
async function resolveSymbol(
  file: string,
  symbol: string,
): Promise<{
  file: string;
  line: number;
  column: number;
  kind: string;
  preview: string;
} | null> {
  // Strategy 1: navbar (file-scoped AST search)
  const bar = await client.navbar(file);
  const found = findInNavBar(bar, symbol);
  if (found) {
    return {
      file,
      line: found.line,
      column: found.offset,
      kind: found.kind,
      preview: readPreview(file, found.line),
    };
  }

  // Strategy 2: navto (project-wide search, filtered by file)
  const items = await client.navto(symbol, 10, file);
  // Prefer exact match in the specified file
  const inFile = items.find((i) => i.name === symbol && i.file === file);
  const best = inFile ?? items.find((i) => i.name === symbol) ?? items[0];

  if (best) {
    return {
      file: best.file,
      line: best.start.line,
      column: best.start.offset,
      kind: best.kind,
      preview: readPreview(best.file, best.start.line),
    };
  }

  return null;
}

function normalizeExistingPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

const normalizedProjectRoot = normalizeExistingPath(projectRoot);

function relPath(absPath: string): string {
  return path.relative(normalizedProjectRoot, normalizeExistingPath(absPath));
}

function absPath(file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(projectRoot, file);
}

// ─── Register Tools ──────────────────────────────────────────────────────────

const allTools = [...navigationTools, ...graphTools];

for (const tool of allTools) {
  mcpServer.tool(tool.name, tool.description, tool.schema, async (params) => {
    const ctx: ToolContext = {
      client,
      moduleGraph,
      moduleResolver,
      projectRoot,
      normalizedProjectRoot,
      relPath,
      absPath,
      resolveSymbol,
      readPreview,
    };
    return tool.handler(ctx, params);
  });
}

// ─── Start ───────────────────────────────────────────────────────────────────

// Disk cache state
let diskCacheFiles: Record<
  string,
  { mtime: number; size: number; imports: ImportEdge[] }
> = {};

async function main() {
  log("Starting TypeGraph MCP server...");
  log(`Project root: ${projectRoot}`);
  log(`tsconfig: ${tsconfigPath}`);

  // Start tsserver and build module graph concurrently
  const [, graphResult] = await Promise.all([
    client.start(),
    buildGraph(projectRoot, tsconfigPath),
  ]);

  moduleGraph = graphResult.graph;
  moduleResolver = graphResult.resolver;
  diskCacheFiles = graphResult.diskCacheFiles;

  // Save disk cache on successful build
  saveDiskCache(projectRoot, tsconfigPath, diskCacheFiles);

  startWatcher(projectRoot, moduleGraph, graphResult.resolver, {
    onFileUpdated: async (filePath) => {
      // Update disk cache entry
      try {
        const stat = fs.statSync(filePath);
        const edges = moduleGraph.forward.get(filePath) ?? [];
        updateCacheEntry(
          diskCacheFiles,
          filePath,
          stat.mtimeMs,
          stat.size,
          edges,
        );
      } catch {
        // Skip unreadable files
      }
      await client.reloadOpenFile(filePath).catch((err) => {
        log(`Failed to reload open file ${relPath(filePath)}:`, err);
      });
    },
    onFileDeleted: (filePath) => {
      removeCacheEntry(diskCacheFiles, filePath);
      client.closeFile(filePath);
    },
  });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  log("MCP server connected and ready");
}

// Graceful shutdown
function shutdown() {
  log("Shutting down...");
  saveDiskCache(projectRoot, tsconfigPath, diskCacheFiles);
  client.shutdown();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  log("Fatal error:", err);
  process.exit(1);
});
