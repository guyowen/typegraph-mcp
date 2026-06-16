/**
 * Shared configuration for typegraph-mcp.
 *
 * Extracts the project root detection logic used by server.ts, check.ts,
 * and smoke-test.ts into a single module.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TypegraphConfig {
  /** Absolute path to the target project root */
  projectRoot: string;
  /** Relative tsconfig path (e.g. "./tsconfig.json") */
  tsconfigPath: string;
  /** Absolute path to the typegraph-mcp tool directory */
  toolDir: string;
  /** Whether typegraph-mcp is embedded inside the project (e.g. plugins/typegraph-mcp/) */
  toolIsEmbedded: boolean;
  /** Path to tool dir — relative to projectRoot if embedded, else absolute */
  toolRelPath: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a TypegraphConfig object.
 * Returns validation result with errors and warnings.
 */
export function validateConfig(
  config: TypegraphConfig,
): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check project root exists
  if (!fs.existsSync(config.projectRoot)) {
    errors.push(`Project root not found: ${config.projectRoot}`);
  }

  // Check tsconfig exists
  const tsconfigAbs = path.resolve(config.projectRoot, config.tsconfigPath);
  if (!fs.existsSync(tsconfigAbs)) {
    errors.push(`tsconfig.json not found at: ${tsconfigAbs}`);
  }

  // Check tool directory exists
  if (!fs.existsSync(config.toolDir)) {
    errors.push(`Tool directory not found: ${config.toolDir}`);
  }

  // Check package.json exists in project root
  const packageJsonPath = path.join(config.projectRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    warnings.push(
      `package.json not found in project root: ${config.projectRoot}`,
    );
  }

  // Check TypeScript is available
  try {
    const tsPath = path.join(
      config.projectRoot,
      "node_modules/typescript/lib/tsserver.js",
    );
    if (!fs.existsSync(tsPath)) {
      warnings.push(
        "TypeScript not found in project — some features may not work",
      );
    }
  } catch {
    warnings.push("TypeScript check failed — some features may not work");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve typegraph-mcp configuration from the tool directory location.
 *
 * Project root detection (three-level fallback):
 *   1. TYPEGRAPH_PROJECT_ROOT env var (explicit override)
 *   2. If toolDir is inside a `plugins/` directory, go up two levels
 *   3. Otherwise, use cwd (standalone deployment, run from target project)
 */
export function resolveConfig(toolDir: string): TypegraphConfig {
  const cwd = process.cwd();

  const projectRoot = process.env["TYPEGRAPH_PROJECT_ROOT"]
    ? path.resolve(cwd, process.env["TYPEGRAPH_PROJECT_ROOT"])
    : path.basename(path.dirname(toolDir)) === "plugins"
      ? path.resolve(toolDir, "../..")
      : cwd;

  const tsconfigPath = process.env["TYPEGRAPH_TSCONFIG"] || "./tsconfig.json";

  const toolIsEmbedded = toolDir.startsWith(projectRoot + path.sep);
  const toolRelPath = toolIsEmbedded
    ? path.relative(projectRoot, toolDir)
    : toolDir;

  return { projectRoot, tsconfigPath, toolDir, toolIsEmbedded, toolRelPath };
}
