import fs from "node:fs";
import path from "node:path";

export type PathApi = Pick<typeof path, "relative" | "isAbsolute" | "sep">;
export type CanonicalizePath = (value: string) => string;

/** Resolve an existing path to its native canonical spelling, or preserve it. */
export function canonicalPathOrSelf(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value;
  }
}

function stripWindowsNamespace(value: string, pathApi: PathApi): string {
  if (pathApi.sep !== "\\") return value;
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function relativeDescendant(root: string, candidate: string, pathApi: PathApi): string | undefined {
  const relative = pathApi.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative;
}

/**
 * Return a strict descendant path using platform-aware comparison rules.
 *
 * The direct path handles the normal case without filesystem calls. When two
 * spellings identify the same Windows path (for example RUNNER~1 versus
 * runneradmin), native realpath is the fallback that reconciles them.
 */
export function relativePathWithin(
  root: string,
  candidate: string,
  pathApi: PathApi = path,
  canonicalize: CanonicalizePath = fs.realpathSync.native,
): string | undefined {
  const cleanRoot = stripWindowsNamespace(root, pathApi);
  const cleanCandidate = stripWindowsNamespace(candidate, pathApi);
  const direct = relativeDescendant(cleanRoot, cleanCandidate, pathApi);
  if (direct !== undefined) return direct;

  try {
    return relativeDescendant(
      stripWindowsNamespace(canonicalize(cleanRoot), pathApi),
      stripWindowsNamespace(canonicalize(cleanCandidate), pathApi),
      pathApi,
    );
  } catch {
    return undefined;
  }
}
