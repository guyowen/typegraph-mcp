/**
 * Graph Tools
 *
 * Module graph query tools: dependency_tree, dependents, import_cycles,
 * shortest_path, subgraph, module_boundary.
 */

import { z } from "zod";
import type { ToolContext, ToolResult } from "./types.js";
import {
  dependencyTree,
  dependents,
  importCycles,
  shortestPath,
  subgraph,
  moduleBoundary,
} from "../core/graph/index.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
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

export const graphTools: ToolDef[] = [
  {
    name: "ts_dependency_tree",
    description:
      "Get the transitive dependency tree (imports) of a file. Shows what a file depends on, directly and transitively.",
    schema: {
      file: z.string().describe("File to analyze (relative or absolute path)"),
      depth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max traversal depth (default: unlimited)"),
      includeTypeOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include type-only imports (default: false)"),
    },
    handler: async (ctx, { file, depth, includeTypeOnly }) => {
      const result = dependencyTree(
        ctx.moduleGraph,
        ctx.absPath(file as string),
        {
          depth: depth as number | undefined,
          includeTypeOnly: includeTypeOnly as boolean,
        },
      );
      return ok({
        root: ctx.relPath(result.root),
        nodes: result.nodes,
        files: result.files.map(ctx.relPath),
      });
    },
  },
  {
    name: "ts_dependents",
    description:
      "Find all files that depend on (import) a given file, directly and transitively. Groups results by package.",
    schema: {
      file: z.string().describe("File to analyze (relative or absolute path)"),
      depth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max traversal depth (default: unlimited)"),
      includeTypeOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include type-only imports (default: false)"),
    },
    handler: async (ctx, { file, depth, includeTypeOnly }) => {
      const result = dependents(ctx.moduleGraph, ctx.absPath(file as string), {
        depth: depth as number | undefined,
        includeTypeOnly: includeTypeOnly as boolean,
      });
      const byPackageRel: Record<string, string[]> = {};
      for (const [pkg, files] of Object.entries(result.byPackage)) {
        byPackageRel[pkg] = files.map(ctx.relPath);
      }
      return ok({
        root: ctx.relPath(result.root),
        nodes: result.nodes,
        directCount: result.directCount,
        files: result.files.map(ctx.relPath),
        byPackage: byPackageRel,
      });
    },
  },
  {
    name: "ts_import_cycles",
    description:
      "Detect circular import dependencies in the project. Returns strongly connected components (cycles) in the import graph.",
    schema: {
      file: z
        .string()
        .optional()
        .describe("Filter to cycles containing this file"),
      package: z
        .string()
        .optional()
        .describe("Filter to cycles within this directory"),
    },
    handler: async (ctx, { file, package: pkg }) => {
      const result = importCycles(ctx.moduleGraph, {
        file: file ? ctx.absPath(file as string) : undefined,
        package: pkg ? ctx.absPath(pkg as string) : undefined,
      });
      return ok({
        count: result.count,
        cycles: result.cycles.map((cycle) => cycle.map(ctx.relPath)),
      });
    },
  },
  {
    name: "ts_shortest_path",
    description:
      "Find the shortest import path between two files. Shows how one module reaches another through the import graph.",
    schema: {
      from: z.string().describe("Source file (relative or absolute path)"),
      to: z.string().describe("Target file (relative or absolute path)"),
      includeTypeOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include type-only imports (default: false)"),
    },
    handler: async (ctx, { from, to, includeTypeOnly }) => {
      const result = shortestPath(
        ctx.moduleGraph,
        ctx.absPath(from as string),
        ctx.absPath(to as string),
        { includeTypeOnly: includeTypeOnly as boolean },
      );
      return ok({
        path: result.path?.map(ctx.relPath) ?? null,
        hops: result.hops,
        chain: result.chain.map((c) => ({
          file: ctx.relPath(c.file),
          imports: c.imports,
        })),
      });
    },
  },
  {
    name: "ts_subgraph",
    description:
      "Extract a subgraph around seed files. Expands by depth hops in the specified direction (imports, dependents, or both).",
    schema: {
      files: z
        .array(z.string())
        .describe("Seed files to expand from (relative or absolute paths)"),
      depth: z
        .number()
        .int()
        .positive()
        .optional()
        .default(1)
        .describe("Hops to expand (default: 1)"),
      direction: z
        .enum(["imports", "dependents", "both"])
        .optional()
        .default("both")
        .describe("Direction to expand (default: both)"),
    },
    handler: async (ctx, { files, depth, direction }) => {
      const result = subgraph(
        ctx.moduleGraph,
        (files as string[]).map(ctx.absPath),
        {
          depth: depth as number,
          direction: direction as "imports" | "dependents" | "both",
        },
      );
      return ok({
        nodes: result.nodes.map(ctx.relPath),
        edges: result.edges.map((e) => ({
          from: ctx.relPath(e.from),
          to: ctx.relPath(e.to),
          specifiers: e.specifiers,
          isTypeOnly: e.isTypeOnly,
        })),
        stats: result.stats,
      });
    },
  },
  {
    name: "ts_module_boundary",
    description:
      "Analyze the boundary of a set of files: incoming/outgoing edges, shared dependencies, and an isolation score. Useful for understanding module coupling.",
    schema: {
      files: z
        .array(z.string())
        .describe(
          "Files defining the module boundary (relative or absolute paths)",
        ),
    },
    handler: async (ctx, { files }) => {
      const result = moduleBoundary(
        ctx.moduleGraph,
        (files as string[]).map(ctx.absPath),
      );
      return ok({
        internalEdges: result.internalEdges,
        incomingEdges: result.incomingEdges.map((e) => ({
          from: ctx.relPath(e.from),
          to: ctx.relPath(e.to),
          specifiers: e.specifiers,
        })),
        outgoingEdges: result.outgoingEdges.map((e) => ({
          from: ctx.relPath(e.from),
          to: ctx.relPath(e.to),
          specifiers: e.specifiers,
        })),
        sharedDependencies: result.sharedDependencies.map(ctx.relPath),
        isolationScore: Math.round(result.isolationScore * 1000) / 1000,
      });
    },
  },
];
