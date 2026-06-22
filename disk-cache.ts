/**
 * Disk Cache — Persistent graph cache for fast restart.
 *
 * Stores parsed import edges on disk so subsequent starts can skip
 * re-parsing unchanged files. Invalidates on tsconfig change, file
 * add/delete/modify, and version mismatch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ImportEdge } from "./module-graph.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface DiskCacheFileEntry {
  mtime: number;
  size: number;
  imports: ImportEdge[];
}

export interface DiskCache {
  version: number;
  projectRoot: string;
  tsconfigHash: string;
  generatedAt: number;
  files: Record<string, DiskCacheFileEntry>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CACHE_VERSION = 1;
const CACHE_DIR = "node_modules/.cache/typegraph-mcp";
const CACHE_FILE = "graph.json";
const MAX_CACHE_SIZE_MB = 50;

const log = (...args: unknown[]) => console.error("[typegraph/cache]", ...args);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCachePath(projectRoot: string): string {
  return path.join(projectRoot, CACHE_DIR, CACHE_FILE);
}

function hashFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return crypto
      .createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 16);
  } catch {
    return "";
  }
}

function getCacheSizeMB(cachePath: string): number {
  try {
    const stat = fs.statSync(cachePath);
    return stat.size / (1024 * 1024);
  } catch {
    return 0;
  }
}

// ─── Load ────────────────────────────────────────────────────────────────────

export function loadDiskCache(
  projectRoot: string,
  tsconfigPath: string,
): DiskCache | null {
  const cachePath = getCachePath(projectRoot);

  if (!fs.existsSync(cachePath)) {
    log("No disk cache found");
    return null;
  }

  try {
    const content = fs.readFileSync(cachePath, "utf-8");
    const cache = JSON.parse(content) as DiskCache;

    // Version check
    if (cache.version !== CACHE_VERSION) {
      log(`Cache version mismatch: ${cache.version} !== ${CACHE_VERSION}`);
      return null;
    }

    // Project root check
    if (cache.projectRoot !== projectRoot) {
      log("Cache project root mismatch");
      return null;
    }

    // Tsconfig hash check
    const currentHash = hashFile(path.resolve(projectRoot, tsconfigPath));
    if (currentHash && cache.tsconfigHash !== currentHash) {
      log("Tsconfig changed, cache invalid");
      return null;
    }

    log(
      `Loaded disk cache: ${Object.keys(cache.files).length} files, ${getCacheSizeMB(cachePath).toFixed(1)}MB`,
    );
    return cache;
  } catch {
    log("Failed to parse disk cache");
    return null;
  }
}

// ─── Validate ────────────────────────────────────────────────────────────────

export function validateDiskCache(
  cache: DiskCache,
  currentFiles: Set<string>,
): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const filePath of Object.keys(cache.files)) {
    if (!currentFiles.has(filePath)) {
      // File was deleted
      invalid.push(filePath);
      continue;
    }

    try {
      const stat = fs.statSync(filePath);
      const entry = cache.files[filePath]!;

      if (entry.mtime !== stat.mtimeMs || entry.size !== stat.size) {
        invalid.push(filePath);
      } else {
        valid.push(filePath);
      }
    } catch {
      invalid.push(filePath);
    }
  }

  // Check for new files not in cache
  for (const filePath of currentFiles) {
    if (!(filePath in cache.files)) {
      invalid.push(filePath);
    }
  }

  return { valid, invalid };
}

// ─── Save ────────────────────────────────────────────────────────────────────

export function saveDiskCache(
  projectRoot: string,
  tsconfigPath: string,
  files: Record<string, DiskCacheFileEntry>,
): void {
  const cachePath = getCachePath(projectRoot);
  const dir = path.dirname(cachePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const cache: DiskCache = {
    version: CACHE_VERSION,
    projectRoot,
    tsconfigHash: hashFile(path.resolve(projectRoot, tsconfigPath)),
    generatedAt: Date.now(),
    files,
  };

  const content = JSON.stringify(cache);
  const sizeMB = Buffer.byteLength(content) / (1024 * 1024);

  if (sizeMB > MAX_CACHE_SIZE_MB) {
    log(
      `Cache too large (${sizeMB.toFixed(1)}MB > ${MAX_CACHE_SIZE_MB}MB), skipping save`,
    );
    return;
  }

  fs.writeFileSync(cachePath, content);
  log(
    `Saved disk cache: ${Object.keys(files).length} files, ${sizeMB.toFixed(1)}MB`,
  );
}

// ─── Clean ───────────────────────────────────────────────────────────────────

export function cleanDiskCache(projectRoot: string): boolean {
  const cachePath = getCachePath(projectRoot);
  if (fs.existsSync(cachePath)) {
    fs.unlinkSync(cachePath);
    log("Disk cache cleaned");
    return true;
  }
  return false;
}

// ─── Update Entry ────────────────────────────────────────────────────────────

export function updateCacheEntry(
  files: Record<string, DiskCacheFileEntry>,
  filePath: string,
  mtime: number,
  size: number,
  imports: ImportEdge[],
): void {
  files[filePath] = { mtime, size, imports };
}

export function removeCacheEntry(
  files: Record<string, DiskCacheFileEntry>,
  filePath: string,
): void {
  delete files[filePath];
}
