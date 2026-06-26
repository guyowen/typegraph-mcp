/**
 * Graph Module
 *
 * Import/export dependency graph builder + pure traversal queries.
 */

// Types
export type { ImportEdge, ModuleGraph, BuildGraphResult } from "./builder.js";

export type {
  DepTreeOpts,
  DepTreeResult,
  DependentsOpts,
  DependentsResult,
  CycleOpts,
  CycleResult,
  PathOpts,
  PathResult,
  SubgraphOpts,
  SubgraphResult,
  BoundaryResult,
} from "./queries.js";

// Builder functions
export {
  discoverFiles,
  resolveProjectImport,
  createResolver,
  buildForwardEdges,
  buildGraph,
  updateFile,
  removeFile,
  startWatcher,
} from "./builder.js";

// Query functions
export {
  dependencyTree,
  clearPackageNameCache,
  dependents,
  importCycles,
  shortestPath,
  subgraph,
  moduleBoundary,
} from "./queries.js";
