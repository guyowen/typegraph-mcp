#!/usr/bin/env node
/**
 * TypeGraph-Go MCP server.
 *
 * 22 tools over four query paths:
 *   - 7 point queries  -> SemanticService  -> tsgo --api  (TypeScript 7)
 *   - 3 LSP tools      -> LspClient        -> @effect/tsgo --lsp (hover/actions)
 *   - 1 diagnostics    -> @effect/tsgo diagnostics --format json
 *   - 1 navigate_to    -> NavigateTo       -> export index (+ LSP coordinates/locals)
 *   - 6 graph queries  -> oxc module graph (backend-independent)
 *   - 4 agent helpers  -> small composites over the same backends
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
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
import type { LspDiagnostic, LspRange } from "./lsp-client.ts";

const config = resolveConfig(path.dirname(new URL(import.meta.url).pathname));
const projectRoot = config.projectRoot;
const tsconfig = path.resolve(projectRoot, config.tsconfigPath);
const projectRootReal = realpath(projectRoot);
const require = createRequire(import.meta.url);

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

async function getLspClient() {
  const nav = await getNavigate();
  return nav.lspClient();
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
}): Promise<{ file: string; offset: number; line: number; column: number } | { error: string }> {
  const sem = await getSemantic();
  const file = abs(params.file);

  if (params.line !== undefined && params.column !== undefined) {
    return { file, offset: sem.locToOffset(file, params.line, params.column), line: params.line, column: params.column };
  }
  if (params.symbol) {
    const loc = await sem.findSymbol(file, params.symbol);
    if (!loc) return { error: `Symbol "${params.symbol}" not found in ${params.file}` };
    return { file, offset: sem.locToOffset(file, loc.line, loc.column), line: loc.line, column: loc.column };
  }
  return { error: "Provide either symbol, or both line and column" };
}

const lspRangeSchema = z.object({
  start: z.object({
    line: z.number().int().positive().describe("1-based start line"),
    column: z.number().int().positive().describe("1-based start column"),
  }),
  end: z.object({
    line: z.number().int().positive().describe("1-based end line"),
    column: z.number().int().positive().describe("1-based end column"),
  }),
});

const diagnosticSchema = z.unknown().describe(
  "Diagnostic from ts_effect_diagnostics or a standard LSP diagnostic. Flat @effect/tsgo diagnostics are normalized before the LSP request.",
);

function pointRange(line: number, column: number): LspRange {
  return { start: { line, column }, end: { line, column } };
}

function lspSeverity(severity: unknown): number | undefined {
  if (typeof severity === "number") return severity;
  switch (String(severity).toLowerCase()) {
    case "error":
      return 1;
    case "warning":
    case "warn":
      return 2;
    case "message":
    case "information":
    case "info":
      return 3;
    case "hint":
      return 4;
    default:
      return undefined;
  }
}

function diagnosticRange(diagnostic: any): LspRange | undefined {
  if (
    typeof diagnostic?.range?.start?.line === "number" &&
    typeof diagnostic?.range?.start?.column === "number" &&
    typeof diagnostic?.range?.end?.line === "number" &&
    typeof diagnostic?.range?.end?.column === "number"
  ) {
    return diagnostic.range as LspRange;
  }
  if (
    typeof diagnostic?.range?.start?.line === "number" &&
    typeof diagnostic?.range?.start?.character === "number" &&
    typeof diagnostic?.range?.end?.line === "number" &&
    typeof diagnostic?.range?.end?.character === "number"
  ) {
    return {
      start: { line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1 },
      end: { line: diagnostic.range.end.line + 1, column: diagnostic.range.end.character + 1 },
    };
  }
  if (
    typeof diagnostic?.line === "number" &&
    typeof diagnostic?.column === "number" &&
    typeof diagnostic?.endLine === "number" &&
    typeof diagnostic?.endColumn === "number"
  ) {
    return {
      start: { line: diagnostic.line, column: diagnostic.column },
      end: { line: diagnostic.endLine, column: diagnostic.endColumn },
    };
  }
  return undefined;
}

function normalizeDiagnosticForCodeAction(diagnostic: unknown): LspDiagnostic | undefined {
  const value = diagnostic as any;
  const range = diagnosticRange(value);
  const message = typeof value?.message === "string" ? value.message : undefined;
  if (!range || !message) return undefined;
  return {
    range,
    ...(lspSeverity(value.severity) ? { severity: lspSeverity(value.severity) } : {}),
    ...(value.code !== undefined ? { code: value.code } : {}),
    source: typeof value.source === "string" ? value.source : "effect",
    message,
    ...(value.data !== undefined ? { data: value.data } : value.name ? { data: { name: value.name } } : {}),
  };
}

function normalizeEffectDiagnostic(diagnostic: any): Record<string, unknown> {
  const range = diagnosticRange(diagnostic);
  return {
    ...diagnostic,
    ...(range ? { range } : {}),
    ...(lspSeverity(diagnostic?.severity) ? { lspSeverity: lspSeverity(diagnostic.severity) } : {}),
    source: diagnostic?.source ?? "effect",
  };
}

async function effectDiagnostics(args: {
  file?: string;
  severity?: string;
  lspconfig?: string;
}): Promise<unknown> {
  const sem = await getSemantic();
  const exe = sem.api.exe;
  if (!exe || exe.source !== "@effect/tsgo") {
    return {
      diagnostics: [],
      summary: { filesChecked: 0, totalFiles: 0, errors: 0, warnings: 0, messages: 0 },
      unavailable: true,
      reason:
        "Effect diagnostics require @effect/tsgo. This project is currently using the plain TypeScript TSGo fallback.",
      source: "typescript",
    };
  }

  let cli: string;
  try {
    cli = path.join(path.dirname(require.resolve("@effect/tsgo/package.json")), "dist", "effect-tsgo.cjs");
  } catch {
    return {
      diagnostics: [],
      summary: { filesChecked: 0, totalFiles: 0, errors: 0, warnings: 0, messages: 0 },
      unavailable: true,
      reason: "@effect/tsgo package is not resolvable from typegraph-mcp",
      source: "@effect/tsgo diagnostics",
    };
  }
  const command = process.execPath;
  const cliArgs = [
    cli,
    "diagnostics",
    ...(args.file ? ["--file", abs(args.file)] : ["--project", tsconfig]),
    "--format",
    "json",
    ...(args.severity ? ["--severity", args.severity] : []),
    ...(args.lspconfig ? ["--lspconfig", args.lspconfig] : []),
  ];

  const result = await new Promise<{ status: number | null; stdout: string; stderr: string; error?: string }>((resolve) => {
    const child = spawn(command, cliArgs, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => resolve({ status: null, stdout, stderr, error: err.message }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

  if (result.error) {
    return { error: result.error, stderr: result.stderr, command, args: cliArgs };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      error: "Effect diagnostics did not return JSON",
      status: result.status,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      command,
      args: cliArgs,
    };
  }

  const diagnostics = Array.isArray(parsed.diagnostics)
    ? parsed.diagnostics.map(normalizeEffectDiagnostic)
    : [];
  return {
    diagnostics,
    summary: parsed.summary ?? {
      filesChecked: 0,
      totalFiles: 0,
      errors: diagnostics.filter((d: any) => d.severity === "error").length,
      warnings: diagnostics.filter((d: any) => d.severity === "warning").length,
      messages: diagnostics.filter((d: any) => d.severity === "message").length,
    },
    count: diagnostics.length,
    exitStatus: result.status,
    source: "@effect/tsgo diagnostics",
    ...(result.stderr.trim() ? { stderr: result.stderr.trim() } : {}),
  };
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

// ─── Tool 5: ts_hover ────────────────────────────────────────────────────────

mcpServer.tool(
  "ts_hover",
  "Editor-style LSP hover at a symbol or coordinate. On Effect projects backed by @effect/tsgo, this includes rich Effect type-parameter blocks and other Effect Language Service hover content.",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveOffset(params);
    if ("error" in loc) return json(loc);
    const lsp = await getLspClient();
    const hover = await lsp.hover(loc.file, { line: loc.line, column: loc.column });
    return json(
      hover ?? {
        kind: null,
        value: null,
        source: "@effect/tsgo-lsp",
        note: "No LSP hover content at this location",
      },
    );
  },
);

// ─── Tool 6: ts_layer_hover ─────────────────────────────────────────────────

mcpServer.tool(
  "ts_layer_hover",
  "Effect Layer-focused hover helper. Returns the TSGo LSP hover plus flags for Layer graph / Mermaid content when @effect/tsgo provides it.",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveOffset(params);
    if ("error" in loc) return json(loc);
    const lsp = await getLspClient();
    const hover = await lsp.hover(loc.file, { line: loc.line, column: loc.column });
    const value = hover?.value ?? "";
    const hasLayerType = /\bLayer\.Layer</.test(value);
    const hasLayerGraph = value.includes("Show full graph") || value.includes("Show outline");
    const mermaidLinks = [...value.matchAll(/\]\((https:\/\/(?:mermaid\.live|mermaid\.com)\/[^)]+)\)/g)].map(
      (match) => match[1]!,
    );
    return json({
      hover,
      isLayerHover: hasLayerType || hasLayerGraph,
      hasLayerType,
      hasLayerGraph,
      mermaidLinks,
      source: "@effect/tsgo-lsp",
      ...(!hover ? { note: "No LSP hover content at this location" } : {}),
      ...(hover && !hasLayerType && !hasLayerGraph
        ? { note: "Hover content was returned, but it did not look like an Effect Layer hover." }
        : {}),
    });
  },
);

// ─── Tool 7: ts_effect_diagnostics ──────────────────────────────────────────

mcpServer.tool(
  "ts_effect_diagnostics",
  "Run @effect/tsgo's Effect Language Service diagnostics in structured JSON form. Use this for Effect-specific correctness/style rules such as floating effects, missing Effect context, catchReason opportunities, and Schema/Layer diagnostics. On plain TypeScript TSGo projects, returns unavailable:true with a reason.",
  {
    file: z.string().optional().describe("Optional file path (relative or absolute). Defaults to the configured tsconfig project."),
    severity: z
      .string()
      .optional()
      .describe("Optional comma-separated severity filter: error,warning,message"),
    lspconfig: z
      .string()
      .optional()
      .describe("Optional inline JSON LSP config passed through to @effect/tsgo diagnostics --lspconfig"),
  },
  async ({ file, severity, lspconfig }) => json(await effectDiagnostics({ file, severity, lspconfig })),
);

// ─── Tool 8: ts_code_actions ────────────────────────────────────────────────

mcpServer.tool(
  "ts_code_actions",
  "List LSP code actions / quick fixes / refactors at a range. For diagnostic quick fixes, pass diagnostics from ts_effect_diagnostics; refactors can be listed with only a symbol or coordinate.",
  {
    ...locationOrSymbol,
    range: lspRangeSchema.optional().describe("Explicit 1-based range. If omitted, uses the symbol/coordinate as a point range."),
    diagnostics: z
      .array(diagnosticSchema)
      .optional()
      .describe("Diagnostics to include in the LSP codeAction context, usually copied from ts_effect_diagnostics."),
    only: z
      .array(z.string())
      .optional()
      .describe("Optional LSP codeAction kind filter, e.g. ['quickfix'] or ['refactor.rewrite']."),
  },
  async (params) => {
    let file: string;
    let range: LspRange;
    if (params.range) {
      file = abs(params.file);
      range = params.range as LspRange;
    } else {
      const loc = await resolveOffset(params);
      if ("error" in loc) return json(loc);
      file = loc.file;
      range = pointRange(loc.line, loc.column);
    }
    const lsp = await getLspClient();
    const actions = await lsp.codeActions({
      absPath: file,
      range,
      diagnostics: params.diagnostics
        ?.map(normalizeDiagnosticForCodeAction)
        .filter((diagnostic): diagnostic is LspDiagnostic => diagnostic !== undefined),
      only: params.only,
    });
    return json({ actions, count: actions.length, source: "@effect/tsgo-lsp" });
  },
);

// ─── Tool 9: ts_navigate_to ──────────────────────────────────────────────────

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

// ─── Tool 10: ts_trace_chain ──────────────────────────────────────────────────

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

// ─── Tool 11: ts_blast_radius ─────────────────────────────────────────────────

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

// ─── Tool 12: ts_module_exports ───────────────────────────────────────────────

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

// ─── Tools 13-16: agent helper composites ─────────────────────────────────────

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
        lsp: "@effect/tsgo --lsp hover/document/workspace symbols/code actions",
        diagnostics: "@effect/tsgo diagnostics --format json when the Effect-patched provider is active",
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

// ─── Tools 17-22: graph queries (oxc) ────────────────────────────────────────

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
