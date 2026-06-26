/**
 * Re-export from src/core/graph/queries.ts for backward compatibility.
 */

export {
  type DepTreeOpts,
  type DepTreeResult,
  type DependentsOpts,
  type DependentsResult,
  type CycleOpts,
  type CycleResult,
  type PathOpts,
  type PathResult,
  type SubgraphOpts,
  type SubgraphResult,
  type BoundaryResult,
  dependencyTree,
  clearPackageNameCache,
  dependents,
  importCycles,
  shortestPath,
  subgraph,
  moduleBoundary,
} from "./src/core/graph/queries.js";
