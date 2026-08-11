/**
 * Shared configuration: which project the server is answering questions about,
 * and where its own code lives relative to that project.
 *
 * The second half matters because the tool's own sources are TypeScript. If the
 * package sits inside the project being analysed, its files would otherwise be
 * walked into the module graph and reported as project results.
 */

import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TypegraphConfig {
  /** Absolute path to the target project root */
  projectRoot: string;
  /** Relative tsconfig path (e.g. "./tsconfig.json") */
  tsconfigPath: string;
  /** Absolute path to this package's root (the directory containing src/) */
  toolDir: string;
  /** Whether this package lives inside the analysed project */
  toolIsEmbedded: boolean;
  /** Path to tool dir — relative to projectRoot if embedded, else absolute */
  toolRelPath: string;
  /** Paths the module graph must not walk. Empty unless the tool is embedded. */
  excludedPaths: string[];
}

// ─── Resolution ──────────────────────────────────────────────────────────────

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

/**
 * Project root, in three steps:
 *   1. TYPEGRAPH_PROJECT_ROOT — what the installer writes into every MCP entry
 *   2. the directory containing the node_modules this package was installed into
 *   3. cwd — a dev checkout run directly against the current project
 */
function inferProjectRoot(packageRoot: string, cwd: string): string {
  const env = process.env["TYPEGRAPH_PROJECT_ROOT"];
  if (env) return path.resolve(cwd, env);

  const at = packageRoot.lastIndexOf(NODE_MODULES);
  if (at !== -1) return packageRoot.slice(0, at);

  return cwd;
}

/**
 * @param srcDir the directory holding this module (i.e. `<package>/src`)
 */
export function resolveConfig(srcDir: string): TypegraphConfig {
  const cwd = process.cwd();
  const toolDir = path.resolve(srcDir, "..");
  const projectRoot = inferProjectRoot(toolDir, cwd);
  const tsconfigPath = process.env["TYPEGRAPH_TSCONFIG"] || "./tsconfig.json";

  const toolIsEmbedded = toolDir.startsWith(projectRoot + path.sep);
  const toolRelPath = toolIsEmbedded ? path.relative(projectRoot, toolDir) : toolDir;

  return {
    projectRoot,
    tsconfigPath,
    toolDir,
    toolIsEmbedded,
    toolRelPath,
    excludedPaths: toolIsEmbedded ? [toolDir] : [],
  };
}
