#!/usr/bin/env node
/**
 * TypeGraph-Go MCP server.
 *
 * 18 tools over two backends:
 *   - 7 point queries  -> SemanticService  -> tsgo --api  (TypeScript 7)
 *   - 1 navigate_to    -> NavigateTo       -> export index (+ LSP coordinates/locals)
 *   - 6 graph queries  -> oxc module graph (backend-independent)
 *   - 4 agent helpers  -> small composites over the same backends
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import * as path from "node:path";
import { resolveConfig } from "./config.ts";
import { buildGraph, type ModuleGraph } from "./module-graph.ts";
import {
  dependencyTree,
  dependents,
  importCycles,
  moduleBoundary,
  shortestPath,
  subgraph,
} from "./graph-queries.ts";
import { ApiClient } from "./api-client.ts";
import { SemanticService } from "./semantic.ts";
import { DEFAULT_MAX_RESULTS, NavigateTo, truncationNotice } from "./navigate-to.ts";
import { Invalidator } from "./invalidation.ts";

const config = resolveConfig(path.dirname(new URL(import.meta.url).pathname));
const projectRoot = config.projectRoot;
const tsconfig = path.resolve(projectRoot, config.tsconfigPath);
const projectRootReal = realpath(projectRoot);

function packageVersion(): string {
  try {
    const pkgPath = path.resolve(import.meta.dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const mcpServer = new McpServer({ name: "typegraph-mcp", version: packageVersion() });

// ─── Lazy backends ───────────────────────────────────────────────────────────
// Both are expensive to build and not every session touches both, so each is
// created on first use rather than at startup.

let apiClient: ApiClient | undefined;
let semantic: SemanticService | undefined;
let navigate: NavigateTo | undefined;
let graph: ModuleGraph | undefined;
let invalidator: Invalidator | undefined;

async function getSemantic(): Promise<SemanticService> {
  if (!semantic) {
    apiClient = await ApiClient.create({ projectRoot, tsconfig });
    semantic = new SemanticService(apiClient);
    invalidator = new Invalidator(projectRoot, apiClient);
    invalidator.semantic = semantic;
    invalidator.start();
  }
  // Apply any edits observed since the last query. No-op when nothing is dirty.
  await invalidator?.settle();
  return semantic;
}

async function getNavigate(): Promise<NavigateTo> {
  if (!navigate) {
    await getSemantic();
    navigate = new NavigateTo(apiClient!);
    await navigate.buildIndex();
    // Registered after the initial build so the first index isn't rebuilt twice.
    invalidator!.navigate = navigate;
  } else {
    await getSemantic();
  }
  return navigate;
}

async function getGraph(): Promise<ModuleGraph> {
  if (!graph) {
    // excludedPaths keeps this package's own sources out of the graph when it
    // is installed inside the project being analysed.
    const result = await buildGraph(projectRoot, tsconfig, config.excludedPaths);
    graph = result.graph;
  }
  return graph;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function realpath(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

function projectPath(value: string): string {
  if (!path.isAbsolute(value)) return value;
  const canonical = realpath(value);
  if (canonical === projectRootReal) return ".";
  if (canonical.startsWith(projectRootReal + path.sep)) {
    return path.relative(projectRootReal, canonical);
  }
  return value;
}

function present(value: unknown): unknown {
  if (typeof value === "string") return projectPath(value);
  if (Array.isArray(value)) return value.map(present);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("__")) continue;
    out[key] = present(child);
  }
  return out;
}

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(present(value)) }],
});

const abs = (file: string): string =>
  path.isAbsolute(file) ? file : path.resolve(projectRoot, file);

/** Accept either explicit coordinates or a symbol name, like the tsserver build did. */
const locationOrSymbol = {
  file: z.string().describe("File path (relative or absolute)"),
  symbol: z.string().optional().describe("Symbol name — alternative to line+column"),
  line: z.number().optional().describe("1-based line number"),
  column: z.number().optional().describe("1-based column number"),
};

async function resolveOffset(params: {
  file: string;
  symbol?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
}): Promise<{ file: string; offset: number } | { error: string }> {
  const sem = await getSemantic();
  const file = abs(params.file);

  if (params.line !== undefined && params.column !== undefined) {
    return { file, offset: sem.locToOffset(file, params.line, params.column) };
  }
  if (params.symbol) {
    const loc = await sem.findSymbol(file, params.symbol);
    if (!loc) return { error: `Symbol "${params.symbol}" not found in ${params.file}` };
    return { file, offset: sem.locToOffset(file, loc.line, loc.column) };
  }
  return { error: "Provide either symbol, or both line and column" };
}

// ─── Tool 1: ts_find_symbol ──────────────────────────────────────────────────

mcpServer.tool(
  "ts_find_symbol",
  "Find a symbol's location in a file by name. Entry point for navigating without exact coordinates.",
  { file: z.string(), symbol: z.string() },
  async ({ file, symbol }) => {
    const sem = await getSemantic();
    const result = await sem.findSymbol(abs(file), symbol);
    return json(result ?? { error: `Symbol "${symbol}" not found in ${file}` });
  },
);

// ─── Tool 2: ts_definition ───────────────────────────────────────────────────

mcpServer.tool(
  "ts_definition",
  "Go to definition. Resolves through imports, re-exports, barrel files, interfaces and generics.",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveOffset(params);
    if ("error" in loc) return json(loc);
    const sem = await getSemantic();
    return json({ definitions: await sem.definition(loc.file, loc.offset) });
  },
);

// ─── Tool 3: ts_references ───────────────────────────────────────────────────

mcpServer.tool(
  "ts_references",
  "Find all semantic references to a symbol (real code references, not string matches).",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveOffset(params);
    if ("error" in loc) return json(loc);
    const sem = await getSemantic();
    const references = await sem.references(loc.file, loc.offset);
    return json({ references, count: references.length });
  },
);

// ─── Tool 4: ts_type_info ────────────────────────────────────────────────────

mcpServer.tool(
  "ts_type_info",
  "Get the TypeScript type and documentation for a symbol — the same info as hovering in an editor.",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveOffset(params);
    if ("error" in loc) return json(loc);
    const sem = await getSemantic();
    return json((await sem.typeInfo(loc.file, loc.offset)) ?? { type: null, documentation: null });
  },
);

// ─── Tool 5: ts_navigate_to ──────────────────────────────────────────────────

mcpServer.tool(
  "ts_navigate_to",
  "Search for a symbol across the entire project without knowing which file it is in. Searches " +
    "exported symbols by default and returns exact, complete counts — safe for prevalence " +
    "comparisons even when the returned list is trimmed by maxResults. Set includeLocals to also " +
    "reach non-exported locals and class members; that half is capped at 256 and reports " +
    "localsTruncated. Pass a file hint to also search that file's document symbols, which is the " +
    "only way to find object-literal property keys such as RPC handler maps and route tables.",
  {
    symbol: z.string().describe("Symbol name to search for"),
    file: z
      .string()
      .optional()
      .describe(
        "Optional file to also search via its document symbols — covers object-literal keys that no project-wide index sees",
      ),
    includeLocals: z
      .boolean()
      .optional()
      .describe("Also search non-exported declarations and class members (capped at 256)"),
    maxResults: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Maximum matches to return (default ${DEFAULT_MAX_RESULTS}). Counts are unaffected.`),
  },
  async ({ symbol, file, includeLocals, maxResults }) => {
    const nav = await getNavigate();
    const result = await nav.query(symbol, {
      includeLocals: includeLocals ?? false,
      ...(file ? { file } : {}),
      maxResults: maxResults ?? DEFAULT_MAX_RESULTS,
    });
    const notice = truncationNotice(result);
    return json({
      matches: result.hits,
      results: result.hits,
      count: result.totalHits,
      exportHits: result.exportHits,
      localHits: result.localHits,
      ...(result.navbarHits > 0 ? { navbarHits: result.navbarHits } : {}),
      localsTruncated: result.localsTruncated,
      totalHits: result.totalHits,
      // Distinct from localsTruncated: the LIST was shortened, the COUNTS were
      // not. Kept separate so a trimmed response is still safe to count from.
      listTrimmed: result.listTrimmed,
      ...(result.listTrimmed
        ? {
            note:
              `Showing ${result.hits.length} of ${result.totalHits} matches, best first. ` +
              `The counts above cover all ${result.totalHits} — raise maxResults to see more.`,
          }
        : {}),
      source: result.source,
      ...(notice ? { warning: notice } : {}),
    });
  },
);

// ─── Tool 6: ts_trace_chain ──────────────────────────────────────────────────

mcpServer.tool(
  "ts_trace_chain",
  "Follow go-to-definition hops from a symbol to its implementation, building a call chain.",
  { ...locationOrSymbol, maxHops: z.number().optional().describe("Maximum hops (default 5)") },
  async (params) => {
    const loc = await resolveOffset(params);
    if ("error" in loc) return json(loc);
    const sem = await getSemantic();
    const chain = await sem.traceChain(loc.file, loc.offset, params.maxHops ?? 5);
    return json({ chain, hops: Math.max(0, chain.length - 1) });
  },
);

// ─── Tool 7: ts_blast_radius ─────────────────────────────────────────────────

mcpServer.tool(
  "ts_blast_radius",
  "Impact analysis: all usage sites of a symbol, grouped by file.",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveOffset(params);
    if ("error" in loc) return json(loc);
    const sem = await getSemantic();
    return json(await sem.blastRadius(loc.file, loc.offset));
  },
);

// ─── Tool 8: ts_module_exports ───────────────────────────────────────────────

mcpServer.tool(
  "ts_module_exports",
  "List all exported symbols of a module with their resolved types.",
  { file: z.string() },
  async ({ file }) => {
    const sem = await getSemantic();
    const exports = await sem.moduleExports(abs(file));
    return json({ exports, count: exports.length });
  },
);

// ─── Tools 9-12: agent helper composites ─────────────────────────────────────

mcpServer.tool(
  "ts_project_info",
  "Summarize the TypeGraph-Go backend, project snapshot, export index, and module graph for calibration.",
  {},
  async () => {
    const sem = await getSemantic();
    const nav = await getNavigate();
    const graph = await getGraph();
    const files = await sem.api.projectFiles();
    const edgeCount = [...graph.forward.values()].reduce((sum, edges) => sum + edges.length, 0);
    return json({
      projectRoot,
      tsconfig,
      backend: {
        name: "typegraph-mcp",
        semantic: "tsgo --api",
        navigate: "export index + optional tsgo LSP document/workspace symbols",
        graph: "oxc-parser + oxc-resolver",
        exe: sem.api.exe,
        versions: sem.api.versions,
      },
      semantic: {
        projectFiles: files.length,
      },
      navigate: nav.stats,
      graph: {
        files: graph.files.size,
        edges: edgeCount,
      },
    });
  },
);

mcpServer.tool(
  "ts_document_symbols",
  "List one file's document symbols, including object-literal keys that project-wide symbol search misses.",
  {
    file: z.string(),
    symbol: z.string().optional().describe("Optional substring filter"),
    maxResults: z.number().int().positive().optional().describe("Maximum symbols to return"),
  },
  async ({ file, symbol, maxResults }) => {
    const nav = await getNavigate();
    const symbols = await nav.documentSymbols(file, symbol);
    const limit = maxResults ?? 100;
    return json({
      symbols: symbols.slice(0, limit),
      count: symbols.length,
      listTrimmed: symbols.length > limit,
    });
  },
);

mcpServer.tool(
  "ts_symbol_overview",
  "One-shot symbol overview: definition, type info, reference count, affected files, and blast radius.",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveOffset(params);
    if ("error" in loc) return json(loc);
    const sem = await getSemantic();
    const [definitions, typeInfo, references, blastRadius] = await Promise.all([
      sem.definition(loc.file, loc.offset),
      sem.typeInfo(loc.file, loc.offset),
      sem.references(loc.file, loc.offset),
      sem.blastRadius(loc.file, loc.offset),
    ]);
    const nonDefinitionReferences = references.filter((ref) => !ref.isDefinition);
    return json({
      symbol: typeInfo?.name ?? params.symbol ?? "",
      definitions,
      typeInfo,
      references: {
        count: references.length,
        nonDefinitionCount: nonDefinitionReferences.length,
        files: [...new Set(nonDefinitionReferences.map((ref) => ref.file))].sort(),
      },
      blastRadius,
    });
  },
);

mcpServer.tool(
  "ts_dead_exports",
  "Audit one module's exports for symbols with no semantic non-definition references.",
  {
    file: z.string(),
    maxResults: z.number().int().positive().optional().describe("Maximum exports to check"),
  },
  async ({ file, maxResults }) => {
    const sem = await getSemantic();
    const absFile = abs(file);
    const exports = await sem.moduleExports(absFile);
    const limit = maxResults ?? 50;
    const checked = [];
    for (const ex of exports.slice(0, limit)) {
      const loc = await sem.findSymbol(absFile, ex.name);
      if (!loc) {
        checked.push({ ...ex, referenceCount: null, possiblyDead: false, note: "symbol not locatable in module" });
        continue;
      }
      const refs = await sem.references(absFile, sem.locToOffset(absFile, loc.line, loc.column));
      const referenceCount = refs.filter((ref) => !ref.isDefinition).length;
      checked.push({
        ...ex,
        referenceCount,
        possiblyDead: referenceCount === 0,
      });
    }
    return json({
      file: absFile,
      checked,
      checkedCount: checked.length,
      totalExports: exports.length,
      listTrimmed: exports.length > limit,
      deadCount: checked.filter((ex) => ex.possiblyDead).length,
    });
  },
);

// ─── Tools 13-18: graph queries (oxc) ────────────────────────────────────────

mcpServer.tool(
  "ts_dependency_tree",
  "Transitive import tree for a file.",
  { file: z.string(), depth: z.number().optional(), includeTypeOnly: z.boolean().optional() },
  async ({ file, depth, includeTypeOnly }) =>
    json(dependencyTree(await getGraph(), abs(file), { depth, includeTypeOnly })),
);

mcpServer.tool(
  "ts_dependents",
  "All files that depend on a given file, grouped by package.",
  { file: z.string(), depth: z.number().optional(), includeTypeOnly: z.boolean().optional() },
  async ({ file, depth, includeTypeOnly }) =>
    json(dependents(await getGraph(), abs(file), { depth, includeTypeOnly })),
);

mcpServer.tool(
  "ts_import_cycles",
  "Detect circular import dependencies (strongly connected components).",
  { file: z.string().optional(), package: z.string().optional() },
  async ({ file, package: pkg }) =>
    json(
      importCycles(await getGraph(), {
        ...(file ? { file: abs(file) } : {}),
        ...(pkg ? { package: pkg } : {}),
      }),
    ),
);

mcpServer.tool(
  "ts_shortest_path",
  "Shortest import path between two files. A null result proves compile-time isolation.",
  { from: z.string(), to: z.string(), includeTypeOnly: z.boolean().optional() },
  async ({ from, to, includeTypeOnly }) =>
    json(shortestPath(await getGraph(), abs(from), abs(to), { includeTypeOnly })),
);

mcpServer.tool(
  "ts_subgraph",
  "Extract the neighborhood around seed files.",
  {
    files: z.array(z.string()),
    depth: z.number().optional(),
    direction: z.enum(["imports", "dependents", "both"]).optional(),
  },
  async ({ files, depth, direction }) =>
    json(subgraph(await getGraph(), files.map(abs), { depth, direction })),
);

mcpServer.tool(
  "ts_module_boundary",
  "Analyze module coupling: incoming/outgoing edges, shared dependencies, isolation score.",
  { files: z.array(z.string()) },
  async ({ files }) => json(moduleBoundary(await getGraph(), files.map(abs))),
);

// ─── Startup ─────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  invalidator?.stop();
  await navigate?.close().catch(() => {});
  await apiClient?.close().catch(() => {});
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
