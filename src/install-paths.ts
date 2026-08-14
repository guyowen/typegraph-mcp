/**
 * The two paths that get baked into agent config files: the Node interpreter
 * and the MCP server script.
 *
 * Both are the same class of hazard — an absolute path written into a config
 * that outlives the thing it points at. Version-manager directories vanish on
 * upgrade, and an npm cache or dev-checkout path can disappear too.
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

function commandSupportsNativeTypeScript(command: string): boolean {
  const version = nodeVersion(command);
  return version !== null && supportsNativeTypeScript(version);
}

/** Resolve fnm's version-specific executable to its stable default alias. */
export function fnmDefaultInterpreter(execPath: string): string | undefined {
  const windowsPath = execPath.includes("\\") || execPath.toLowerCase().endsWith(".exe");
  const normalized = execPath.replaceAll("\\", "/");
  const match = /^(.*\/fnm)\/node-versions\/v[^/]+\/installation\/(?:bin\/node|node(?:\.exe)?)$/i.exec(
    normalized,
  );
  if (!match) return undefined;
  const candidate = windowsPath
    ? `${match[1]}/aliases/default/node.exe`
    : `${match[1]}/aliases/default/bin/node`;
  return windowsPath ? candidate.replaceAll("/", "\\") : candidate;
}

/**
 * Pick an interpreter that satisfies the package runtime floor.
 *
 * `process.execPath` under nvm and fnm contains the selected Node version — that
 * exact path can disappear on upgrade, silently breaking every config that
 * baked it. Both managers maintain a `default` alias we can indirect through;
 * failing that we fall back to a compatible `node` on PATH, and only then to
 * the absolute path that is running setup. A version-pinned path is still
 * better than a portable command that resolves to Node too old to run this
 * package.
 */
export function resolveInterpreter(): { command: string; stable: boolean; note?: string } {
  const execPath = process.execPath;
  const fnmDefault = fnmDefaultInterpreter(execPath);

  if (fnmDefault) {
    if (fs.existsSync(fnmDefault) && commandSupportsNativeTypeScript(fnmDefault)) {
      return {
        command: fnmDefault,
        stable: true,
        note: "resolved through the fnm default alias instead of a version-pinned installation",
      };
    }
    if (commandSupportsNativeTypeScript("node")) {
      return {
        command: "node",
        stable: true,
        note: "using `node` from PATH — fnm version paths rot on upgrade",
      };
    }
    return {
      command: execPath,
      stable: false,
      note:
        `using the current fnm Node because its default alias/PATH runtime is below ${MIN_NODE_VERSION}; ` +
        "`check` will detect breakage after a Node upgrade",
    };
  }

  const nvmMatch = /^(.*\/\.nvm)\/versions\/node\/v[^/]+\/bin\/node$/.exec(execPath);

  if (nvmMatch) {
    const nvmRoot = nvmMatch[1]!;
    const aliasFile = path.join(nvmRoot, "alias", "default");
    if (fs.existsSync(aliasFile)) {
      const alias = fs.readFileSync(aliasFile, "utf-8").trim();
      // The alias may be a version ("24.14.0") or a stream name ("lts/*").
      const candidate = path.join(nvmRoot, "versions", "node", `v${alias.replace(/^v/, "")}`, "bin", "node");
      if (fs.existsSync(candidate)) {
        if (commandSupportsNativeTypeScript(candidate)) {
          return {
            command: candidate,
            stable: false,
            note: "resolved via nvm default alias; still version-pinned, `check` will detect breakage",
          };
        }
      }
    }
    if (commandSupportsNativeTypeScript("node")) {
      return {
        command: "node",
        stable: true,
        note: "using `node` from PATH — nvm paths are version-pinned and rot on upgrade",
      };
    }
    if (supportsNativeTypeScript(process.versions.node)) {
      return {
        command: execPath,
        stable: false,
        note:
          `using the current Node executable because PATH/default Node is below ${MIN_NODE_VERSION}; ` +
          "`check` will detect breakage after a Node upgrade",
      };
    }
    return {
      command: "node",
      stable: false,
      note: `node on PATH is below ${MIN_NODE_VERSION}; configure nvm/fnm/mise and rerun setup`,
    };
  }

  return {
    command: execPath,
    stable: commandSupportsNativeTypeScript(execPath),
    ...(!commandSupportsNativeTypeScript(execPath)
      ? { note: `Node ${process.versions.node} is below ${MIN_NODE_VERSION}; use a newer Node runtime` }
      : {}),
  };
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
 *      point at nothing — the same silent breakage as a rotted nvm path.
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
  // path that dies on the next upgrade, which is the exact failure mode
  // resolveInterpreter() exists to avoid. The symlink is the stable name.
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

/** The path to write for a config file of the given scope. */
export function serverArgFor(target: ServerTarget, scope: "project" | "global"): string {
  return scope === "project" ? (target.relative ?? target.absolute) : target.absolute;
}
