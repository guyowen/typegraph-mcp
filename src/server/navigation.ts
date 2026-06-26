/**
 * Navigation Tools
 *
 * Point query tools: find_symbol, definition, references, type_info,
 * navigate_to, trace_chain, blast_radius, module_exports.
 */

import { z } from "zod";
import type { ToolContext, ToolResult } from "./types.js";
import {
  getModuleExports,
  EXPORT_KINDS,
  type ModuleExportRecord,
} from "../../export-resolver.js";
import { resolveProjectImport } from "../core/graph/index.js";

// ─── Shared Schemas ─────────────────────────────────────────────────────────

export const locationOrSymbol = {
  file: z.string().describe("File path (relative to project root or absolute)"),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Line number (1-based). Required if symbol is not provided."),
  column: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Column/offset (1-based). Required if symbol is not provided."),
  symbol: z
    .string()
    .optional()
    .describe("Symbol name to find. Alternative to line+column."),
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function resolveParams(
  ctx: ToolContext,
  params: {
    file: string;
    line?: number;
    column?: number;
    symbol?: string;
  },
): Promise<{ file: string; line: number; column: number } | { error: string }> {
  if (params.line !== undefined && params.column !== undefined) {
    return { file: params.file, line: params.line, column: params.column };
  }
  if (params.symbol) {
    const resolved = await ctx.resolveSymbol(params.file, params.symbol);
    if (!resolved) {
      return { error: `Symbol "${params.symbol}" not found in ${params.file}` };
    }
    return {
      file: resolved.file,
      line: resolved.line,
      column: resolved.column,
    };
  }
  return { error: "Either line+column or symbol must be provided" };
}

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function err(error: string): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
  };
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (
    ctx: ToolContext,
    params: Record<string, unknown>,
  ) => Promise<ToolResult>;
}

export const navigationTools: ToolDef[] = [
  {
    name: "ts_find_symbol",
    description:
      "Find a symbol's location in a file by name. Entry point for navigating without exact coordinates.",
    schema: {
      file: z
        .string()
        .describe("File to search in (relative or absolute path)"),
      symbol: z.string().describe("Symbol name to find"),
    },
    handler: async (ctx, { file, symbol }) => {
      const result = await ctx.resolveSymbol(file as string, symbol as string);
      if (!result) {
        return err(`Symbol "${symbol}" not found in ${file}`);
      }
      return ok(result);
    },
  },
  {
    name: "ts_definition",
    description:
      "Go to definition. Resolves through imports, re-exports, barrel files, interfaces, generics. Provide either line+column coordinates or a symbol name.",
    schema: locationOrSymbol,
    handler: async (ctx, params) => {
      const loc = await resolveParams(ctx, params as any);
      if ("error" in loc) return ok(loc);

      const defs = await ctx.client.definition(loc.file, loc.line, loc.column);
      if (defs.length === 0) {
        return ok({
          definitions: [],
          source: ctx.readPreview(loc.file, loc.line),
        });
      }

      const results = defs.map((d) => ({
        file: d.file,
        line: d.start.line,
        column: d.start.offset,
        preview: ctx.readPreview(d.file, d.start.line),
      }));

      return ok({ definitions: results });
    },
  },
  {
    name: "ts_references",
    description:
      "Find all references to a symbol. Returns semantic code references only (not string matches). Provide either line+column or symbol name.",
    schema: locationOrSymbol,
    handler: async (ctx, params) => {
      const loc = await resolveParams(ctx, params as any);
      if ("error" in loc) return ok(loc);

      const refs = await ctx.client.references(loc.file, loc.line, loc.column);
      const results = refs.map((r) => ({
        file: r.file,
        line: r.start.line,
        column: r.start.offset,
        preview: r.lineText.trim(),
        isDefinition: r.isDefinition,
      }));

      return ok({ references: results, count: results.length });
    },
  },
  {
    name: "ts_type_info",
    description:
      "Get the TypeScript type and documentation for a symbol. Returns the same info you see when hovering in VS Code. Provide either line+column or symbol name.",
    schema: locationOrSymbol,
    handler: async (ctx, params) => {
      const loc = await resolveParams(ctx, params as any);
      if ("error" in loc) return ok(loc);

      const info = await ctx.client.quickinfo(loc.file, loc.line, loc.column);
      if (!info) {
        return ok({
          type: null,
          documentation: null,
          source: ctx.readPreview(loc.file, loc.line),
        });
      }

      return ok({
        type: info.displayString,
        documentation: info.documentation || null,
        kind: info.kind,
      });
    },
  },
  {
    name: "ts_navigate_to",
    description:
      "Search for a symbol across the entire project without knowing which file it's in. Returns matching declarations. Optionally provide a file hint to also search that file's navbar (useful for object literal keys like RPC handlers that navto doesn't index).",
    schema: {
      symbol: z.string().describe("Symbol name to search for"),
      file: z
        .string()
        .optional()
        .describe(
          "Optional file to also search via navbar (covers object literal keys not indexed by navto)",
        ),
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .default(10)
        .describe("Maximum results (default 10)"),
    },
    handler: async (ctx, { symbol, file, maxResults }) => {
      const items = await ctx.client.navto(
        symbol as string,
        maxResults as number,
      );
      const results = items.map((item) => ({
        file: item.file,
        line: item.start.line,
        column: item.start.offset,
        kind: item.kind,
        containerName: item.containerName,
        matchKind: item.matchKind,
      }));

      if (file) {
        const navbarHit = await ctx.resolveSymbol(
          file as string,
          symbol as string,
        );
        if (navbarHit) {
          const alreadyFound = results.some(
            (r) => r.file === navbarHit.file && r.line === navbarHit.line,
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

      return ok({ results, count: results.length });
    },
  },
  {
    name: "ts_trace_chain",
    description:
      "Automatically follow go-to-definition hops from a symbol, building a call chain from entry point to implementation. Stops when it reaches the bottom or a cycle.",
    schema: {
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
    handler: async (ctx, { file, symbol, maxHops }) => {
      const start = await ctx.resolveSymbol(file as string, symbol as string);
      if (!start) {
        return err(`Symbol "${symbol}" not found in ${file}`);
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

      let current = {
        file: start.file,
        line: start.line,
        offset: start.column,
      };

      for (let i = 0; i < (maxHops as number); i++) {
        const defs = await ctx.client.definition(
          current.file,
          current.line,
          current.offset,
        );
        if (defs.length === 0) break;

        const def = defs[0]!;
        if (def.file === current.file && def.start.line === current.line) break;
        if (def.file.includes("node_modules")) break;

        const preview = ctx.readPreview(def.file, def.start.line);
        chain.push({
          file: def.file,
          line: def.start.line,
          column: def.start.offset,
          preview,
        });

        current = {
          file: def.file,
          line: def.start.line,
          offset: def.start.offset,
        };
      }

      return ok({ chain, hops: chain.length - 1 });
    },
  },
  {
    name: "ts_blast_radius",
    description:
      "Analyze the impact of changing a symbol. Finds all references, filters to usage sites, and reports affected files.",
    schema: {
      file: z.string().describe("File containing the symbol"),
      symbol: z.string().describe("Symbol to analyze"),
    },
    handler: async (ctx, { file, symbol }) => {
      const start = await ctx.resolveSymbol(file as string, symbol as string);
      if (!start) {
        return err(`Symbol "${symbol}" not found in ${file}`);
      }

      const refs = await ctx.client.references(
        start.file,
        start.line,
        start.column,
      );
      const callers = refs.filter((r) => !r.isDefinition);
      const filesAffected = [...new Set(callers.map((r) => r.file))];

      const callerList = callers.map((r) => ({
        file: r.file,
        line: r.start.line,
        preview: r.lineText.trim(),
      }));

      return ok({
        directCallers: callers.length,
        filesAffected,
        callers: callerList,
      });
    },
  },
  {
    name: "ts_module_exports",
    description:
      "List all exported symbols from a module with their resolved types, including re-exports when possible. Gives an at-a-glance understanding of what a file provides.",
    schema: {
      file: z.string().describe("File to inspect"),
    },
    handler: async (ctx, { file }) => {
      const exports = await getModuleExports(
        ctx.client,
        ctx.moduleResolver,
        ctx.projectRoot,
        ctx.relPath,
        (fromDir, specifier) =>
          resolveProjectImport(
            ctx.moduleResolver,
            fromDir,
            specifier,
            ctx.projectRoot,
          ),
        file as string,
      );
      const localCount = exports.filter(
        (item) => item.source === "local",
      ).length;
      const reExportCount = exports.length - localCount;
      const typeOnlyCount = exports.filter((item) => item.isTypeOnly).length;
      const valueCount = exports.length - typeOnlyCount;
      const namespaceExportCount = exports.filter(
        (item) => item.isNamespace,
      ).length;
      const hasLocalRuntimeExports = exports.some(
        (item) => item.source === "local" && !item.isTypeOnly,
      );
      const isPrimarilyBarrel =
        exports.length > 0 && localCount < reExportCount;

      return ok({
        file,
        exports,
        count: exports.length,
        localCount,
        reExportCount,
        typeOnlyCount,
        valueCount,
        namespaceExportCount,
        hasLocalRuntimeExports,
        isPrimarilyBarrel,
      });
    },
  },
];
