#!/usr/bin/env npx tsx
/**
 * TS Nav MCP Server — Type-aware codebase navigation for AI coding agents.
 *
 * Bridges MCP protocol (stdin/stdout) to tsserver (child process pipes).
 * Provides 8 tools for definition, references, type info, symbol search,
 * call chain tracing, blast radius analysis, and module export inspection.
 *
 * Usage:
 *   npx tsx server.ts
 *
 * Environment:
 *   TS_NAV_PROJECT_ROOT  — project root (default: cwd)
 *   TS_NAV_TSCONFIG      — tsconfig path (default: ./tsconfig.json)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TsServerClient, type NavBarItem } from "./tsserver-client.js";
import * as fs from "node:fs";

// ─── Configuration ───────────────────────────────────────────────────────────

const projectRoot = process.env["TS_NAV_PROJECT_ROOT"] || process.cwd();
const tsconfigPath = process.env["TS_NAV_TSCONFIG"] || "./tsconfig.json";

const log = (...args: unknown[]) => console.error("[ts-nav]", ...args);

// ─── Initialize ──────────────────────────────────────────────────────────────

const client = new TsServerClient(projectRoot, tsconfigPath);

const mcpServer = new McpServer({
  name: "ts-nav",
  version: "1.0.0",
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read a preview line from a file at a 1-based line number */
function readPreview(file: string, line: number): string {
  try {
    const absPath = client.resolvePath(file);
    const content = fs.readFileSync(absPath, "utf-8");
    return content.split("\n")[line - 1]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Search a navbar tree recursively for a symbol by name */
function findInNavBar(
  items: NavBarItem[],
  symbol: string
): { line: number; offset: number; kind: string } | null {
  for (const item of items) {
    if (item.text === symbol && item.spans.length > 0) {
      const span = item.spans[0]!;
      return { line: span.start.line, offset: span.start.offset, kind: item.kind };
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
  symbol: string
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
  const inFile = items.find(
    (i) => i.name === symbol && i.file === file
  );
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

// ─── Tool Schemas ────────────────────────────────────────────────────────────

/**
 * Shared schema for tools that accept either coordinates (file+line+column)
 * or a symbol name (file+symbol). The MCP SDK requires a flat object schema.
 */
const locationOrSymbol = {
  file: z.string().describe("File path (relative to project root or absolute)"),
  line: z.number().int().positive().optional().describe("Line number (1-based). Required if symbol is not provided."),
  column: z.number().int().positive().optional().describe("Column/offset (1-based). Required if symbol is not provided."),
  symbol: z.string().optional().describe("Symbol name to find. Alternative to line+column."),
};

/** Resolve params to coordinates: use line+column if provided, else find symbol */
async function resolveParams(
  params: { file: string; line?: number; column?: number; symbol?: string }
): Promise<{ file: string; line: number; column: number } | { error: string }> {
  if (params.line !== undefined && params.column !== undefined) {
    return { file: params.file, line: params.line, column: params.column };
  }
  if (params.symbol) {
    const resolved = await resolveSymbol(params.file, params.symbol);
    if (!resolved) {
      return { error: `Symbol "${params.symbol}" not found in ${params.file}` };
    }
    return { file: resolved.file, line: resolved.line, column: resolved.column };
  }
  return { error: "Either line+column or symbol must be provided" };
}

// ─── Tool 1: ts_find_symbol ─────────────────────────────────────────────────

mcpServer.tool(
  "ts_find_symbol",
  "Find a symbol's location in a file by name. Entry point for navigating without exact coordinates.",
  {
    file: z.string().describe("File to search in (relative or absolute path)"),
    symbol: z.string().describe("Symbol name to find"),
  },
  async ({ file, symbol }) => {
    const result = await resolveSymbol(file, symbol);
    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Symbol "${symbol}" not found in ${file}` }),
          },
        ],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

// ─── Tool 2: ts_definition ──────────────────────────────────────────────────

mcpServer.tool(
  "ts_definition",
  "Go to definition. Resolves through imports, re-exports, barrel files, interfaces, generics. Provide either line+column coordinates or a symbol name.",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveParams(params);
    if ("error" in loc) {
      return { content: [{ type: "text" as const, text: JSON.stringify(loc) }] };
    }

    const defs = await client.definition(loc.file, loc.line, loc.column);
    if (defs.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ definitions: [], source: readPreview(loc.file, loc.line) }),
          },
        ],
      };
    }

    const results = defs.map((d) => ({
      file: d.file,
      line: d.start.line,
      column: d.start.offset,
      preview: readPreview(d.file, d.start.line),
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ definitions: results }) }],
    };
  }
);

// ─── Tool 3: ts_references ──────────────────────────────────────────────────

mcpServer.tool(
  "ts_references",
  "Find all references to a symbol. Returns semantic code references only (not string matches). Provide either line+column or symbol name.",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveParams(params);
    if ("error" in loc) {
      return { content: [{ type: "text" as const, text: JSON.stringify(loc) }] };
    }

    const refs = await client.references(loc.file, loc.line, loc.column);
    const results = refs.map((r) => ({
      file: r.file,
      line: r.start.line,
      column: r.start.offset,
      preview: r.lineText.trim(),
      isDefinition: r.isDefinition,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ references: results, count: results.length }),
        },
      ],
    };
  }
);

// ─── Tool 4: ts_type_info ───────────────────────────────────────────────────

mcpServer.tool(
  "ts_type_info",
  "Get the TypeScript type and documentation for a symbol. Returns the same info you see when hovering in VS Code. Provide either line+column or symbol name.",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveParams(params);
    if ("error" in loc) {
      return { content: [{ type: "text" as const, text: JSON.stringify(loc) }] };
    }

    const info = await client.quickinfo(loc.file, loc.line, loc.column);
    if (!info) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              type: null,
              documentation: null,
              source: readPreview(loc.file, loc.line),
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            type: info.displayString,
            documentation: info.documentation || null,
            kind: info.kind,
          }),
        },
      ],
    };
  }
);

// ─── Tool 5: ts_navigate_to ─────────────────────────────────────────────────

mcpServer.tool(
  "ts_navigate_to",
  "Search for a symbol across the entire project without knowing which file it's in. Returns matching declarations. Optionally provide a file hint to also search that file's navbar (useful for object literal keys like RPC handlers that navto doesn't index).",
  {
    symbol: z.string().describe("Symbol name to search for"),
    file: z.string().optional().describe("Optional file to also search via navbar (covers object literal keys not indexed by navto)"),
    maxResults: z
      .number()
      .int()
      .positive()
      .optional()
      .default(10)
      .describe("Maximum results (default 10)"),
  },
  async ({ symbol, file, maxResults }) => {
    const items = await client.navto(symbol, maxResults);
    const results = items.map((item) => ({
      file: item.file,
      line: item.start.line,
      column: item.start.offset,
      kind: item.kind,
      containerName: item.containerName,
      matchKind: item.matchKind,
    }));

    // Supplement with navbar search when a file hint is provided.
    // This covers object literal property keys (e.g. RPC handlers)
    // that tsserver's navto command doesn't index.
    if (file) {
      const navbarHit = await resolveSymbol(file, symbol);
      if (navbarHit) {
        const alreadyFound = results.some(
          (r) => r.file === navbarHit.file && r.line === navbarHit.line
        );
        if (!alreadyFound) {
          results.unshift({
            file: navbarHit.file,
            line: navbarHit.line,
            column: navbarHit.column,
            kind: navbarHit.kind,
            containerName: "",
            matchKind: "navbar",
          });
        }
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ results, count: results.length }),
        },
      ],
    };
  }
);

// ─── Tool 6: ts_trace_chain ─────────────────────────────────────────────────

mcpServer.tool(
  "ts_trace_chain",
  "Automatically follow go-to-definition hops from a symbol, building a call chain from entry point to implementation. Stops when it reaches the bottom or a cycle.",
  {
    file: z.string().describe("Starting file"),
    symbol: z.string().describe("Starting symbol name"),
    maxHops: z
      .number()
      .int()
      .positive()
      .optional()
      .default(5)
      .describe("Maximum hops to follow (default 5)"),
  },
  async ({ file, symbol, maxHops }) => {
    const start = await resolveSymbol(file, symbol);
    if (!start) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Symbol "${symbol}" not found in ${file}` }),
          },
        ],
      };
    }

    const chain: Array<{
      file: string;
      line: number;
      column: number;
      preview: string;
    }> = [
      {
        file: start.file,
        line: start.line,
        column: start.column,
        preview: start.preview,
      },
    ];

    let current = { file: start.file, line: start.line, offset: start.column };

    for (let i = 0; i < maxHops; i++) {
      const defs = await client.definition(current.file, current.line, current.offset);
      if (defs.length === 0) break;

      const def = defs[0]!;
      // Stop if we've reached the same location (self-reference)
      if (def.file === current.file && def.start.line === current.line) break;
      // Stop if we've entered node_modules (external dependency)
      if (def.file.includes("node_modules")) break;

      const preview = readPreview(def.file, def.start.line);
      chain.push({
        file: def.file,
        line: def.start.line,
        column: def.start.offset,
        preview,
      });

      current = { file: def.file, line: def.start.line, offset: def.start.offset };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ chain, hops: chain.length - 1 }),
        },
      ],
    };
  }
);

// ─── Tool 7: ts_blast_radius ────────────────────────────────────────────────

mcpServer.tool(
  "ts_blast_radius",
  "Analyze the impact of changing a symbol. Finds all references, filters to usage sites, and reports affected files.",
  {
    file: z.string().describe("File containing the symbol"),
    symbol: z.string().describe("Symbol to analyze"),
  },
  async ({ file, symbol }) => {
    const start = await resolveSymbol(file, symbol);
    if (!start) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Symbol "${symbol}" not found in ${file}` }),
          },
        ],
      };
    }

    const refs = await client.references(start.file, start.line, start.column);
    const callers = refs.filter((r) => !r.isDefinition);
    const filesAffected = [...new Set(callers.map((r) => r.file))];

    const callerList = callers.map((r) => ({
      file: r.file,
      line: r.start.line,
      preview: r.lineText.trim(),
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            directCallers: callers.length,
            filesAffected,
            callers: callerList,
          }),
        },
      ],
    };
  }
);

// ─── Tool 8: ts_module_exports ──────────────────────────────────────────────

mcpServer.tool(
  "ts_module_exports",
  "List all exported symbols from a module with their resolved types. Gives an at-a-glance understanding of what a file provides.",
  {
    file: z.string().describe("File to inspect"),
  },
  async ({ file }) => {
    const bar = await client.navbar(file);
    if (bar.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `No symbols found in ${file}` }),
          },
        ],
      };
    }

    // The top-level navbar item is the module itself — its children are exports
    const moduleItem = bar.find((item) => item.kind === "module");
    const topItems = moduleItem?.childItems ?? bar;

    // Filter to meaningful declarations (skip imports, local vars, etc.)
    const exportKinds = new Set([
      "function",
      "const",
      "class",
      "interface",
      "type",
      "enum",
      "var",
      "let",
      "method",
    ]);
    const candidates = topItems.filter((item) => exportKinds.has(item.kind));

    const exports: Array<{
      symbol: string;
      kind: string;
      line: number;
      type: string | null;
    }> = [];

    for (const item of candidates) {
      if (!item.spans[0]) continue;
      const span = item.spans[0];

      // Get type info for this symbol
      const info = await client.quickinfo(file, span.start.line, span.start.offset);

      exports.push({
        symbol: item.text,
        kind: item.kind,
        line: span.start.line,
        type: info?.displayString ?? null,
      });
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ file, exports, count: exports.length }),
        },
      ],
    };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  log("Starting ts-nav MCP server...");
  log(`Project root: ${projectRoot}`);
  log(`tsconfig: ${tsconfigPath}`);

  await client.start();

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  log("MCP server connected and ready");
}

// Graceful shutdown
process.on("SIGINT", () => {
  log("Shutting down...");
  client.shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  client.shutdown();
  process.exit(0);
});

main().catch((err) => {
  log("Fatal error:", err);
  process.exit(1);
});
