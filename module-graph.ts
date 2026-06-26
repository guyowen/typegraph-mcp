/**
 * Re-export from src/core/graph/builder.ts for backward compatibility.
 */

export {
  type ImportEdge,
  type ModuleGraph,
  type BuildGraphResult,
  discoverFiles,
  resolveProjectImport,
  createResolver,
  buildForwardEdges,
  buildGraph,
  updateFile,
  removeFile,
  startWatcher,
} from "./src/core/graph/builder.js";
