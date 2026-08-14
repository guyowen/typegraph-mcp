/**
 * Resolve the Node runtime floor and the MCP server script written into agent
 * config files.
 *
 * Project configs always invoke `node` from PATH. The remaining path hazard is
 * the package entrypoint: npm cache and dev-checkout absolutes can disappear,
 * while project dependency paths must stay portable across operating systems.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

export const PACKAGE_NAME = "typegraph-mcp";
export const MIN_NODE_VERSION = "22.18.0";

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function supportsNativeTypeScript(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const [major, minor, patch] = parsed;
  const [minMajor, minMinor, minPatch] = parseVersion(MIN_NODE_VERSION)!;
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

export function nodeVersion(command: string): string | null {
  const result = spawnSync(command, ["-p", "process.versions.node"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export interface ServerTarget {
  /** Absolute path to the package root. */
  packageRoot: string;
  /** Absolute path to the MCP server trampoline. */
  absolute: string;
  /**
   * Project-relative path to the server trampoline, when the package lives inside the
   * project. Null otherwise. Preferred for project-scoped configs, which are
   * usually committed: an absolute path there breaks every teammate.
   */
  relative: string | null;
  /** False when the location is expected to disappear (npx cache). */
  stable: boolean;
  note?: string;
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * Decide which copy of the package the agent configs should point at.
 *
 * Preference order:
 *   1. A copy resolvable from the project (a real dependency) — portable, and
 *      npm already installed its runtime deps.
 *   2. The running copy, if it happens to live inside the project.
 *   3. The running copy, absolute. Flagged unstable when it is an npx cache
 *      entry, because npm garbage-collects those and the config would then
 *      point at nothing after npm garbage collection.
 */
export function resolveServerTarget(projectRoot: string, sourceDir: string): ServerTarget {
  const make = (packageRoot: string, extra: Partial<ServerTarget> = {}): ServerTarget => {
    const distServer = path.join(packageRoot, "dist", "server.cjs");
    const absolute = fs.existsSync(distServer) ? distServer : path.join(packageRoot, "src", "server.cjs");
    return {
      packageRoot,
      absolute,
      relative: isInside(projectRoot, packageRoot) ? path.relative(projectRoot, absolute) : null,
      stable: true,
      ...extra,
    };
  };

  // The literal node_modules entry is checked BEFORE require.resolve, which
  // returns a realpath. Under pnpm that realpath is
  // node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg> — a version-pinned
  // path that dies on the next upgrade. The symlink is the stable name.
  const direct = path.join(projectRoot, "node_modules", PACKAGE_NAME);
  if (fs.existsSync(path.join(direct, "package.json"))) return make(direct);

  try {
    const require = createRequire(path.join(projectRoot, "package.json"));
    const manifest = require.resolve(`${PACKAGE_NAME}/package.json`);
    return make(path.dirname(manifest));
  } catch {
    // Not a dependency of the target project — fall through to the running copy.
  }

  if (isInside(projectRoot, sourceDir)) return make(sourceDir);

  if (sourceDir.includes(`${path.sep}_npx${path.sep}`)) {
    return make(sourceDir, {
      stable: false,
      note:
        `running from the npx cache (${sourceDir}).\n` +
        `    npm garbage-collects that directory, which would leave the MCP entry\n` +
        `    pointing at nothing. Install it for real instead:\n` +
        `      npm install --save-dev ${PACKAGE_NAME} && npx typegraph-mcp setup`,
    });
  }

  return make(sourceDir, {
    note: `${PACKAGE_NAME} is not a dependency of this project, so configs carry an absolute path. Add it as a devDependency for a committable config.`,
  });
}

/** Node accepts forward slashes on every supported platform. */
export function portableNodePath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function serverArgFor(target: ServerTarget): string {
  return portableNodePath(target.relative ?? target.absolute);
}
