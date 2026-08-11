/**
 * Keeps the semantic backend current as files change on disk.
 *
 * Sized from measurement, not assumption (tests/refresh-bench.ts, 1506 files):
 *
 *   full re-snapshot          3.5ms
 *   applyChanges(1 file)      1.3ms
 *   reindex(1 file)           1.4ms
 *   full index rebuild      115.7ms
 *
 * So the snapshot was never the expensive part — tsgo keeps the program warm
 * and re-snapshotting is nearly free. The cost is the navigate export index, at
 * ~83x the price of a targeted re-index. That is why this module tracks a dirty
 * SET of paths rather than a boolean: knowing *which* files moved is worth far
 * more than knowing *that* something moved.
 *
 * Work is applied lazily, immediately before a query, so a burst of edits
 * collapses into one refresh instead of one per event.
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiClient } from "./api-client.ts";
import type { NavigateTo } from "./navigate-to.ts";
import type { SemanticService } from "./semantic.ts";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage"]);

export interface InvalidationStats {
  refreshes: number;
  filesReindexed: number;
  lastRefreshMs: number;
}

export class Invalidator {
  #changed = new Set<string>();
  #deleted = new Set<string>();
  #watcher: fs.FSWatcher | undefined;
  #applying: Promise<void> | undefined;

  readonly stats: InvalidationStats = { refreshes: 0, filesReindexed: 0, lastRefreshMs: 0 };

  readonly projectRoot: string;
  readonly api: ApiClient;
  navigate: NavigateTo | undefined;
  semantic: SemanticService | undefined;

  // Explicit assignment, not parameter properties — see package.json "//engines".
  constructor(projectRoot: string, api: ApiClient) {
    this.projectRoot = projectRoot;
    this.api = api;
  }

  start(): void {
    if (this.#watcher) return;
    try {
      this.#watcher = fs.watch(this.projectRoot, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (!TS_EXTENSIONS.has(path.extname(filename))) return;
        if (filename.split(path.sep).some((p) => SKIP_DIRS.has(p))) return;

        const abs = path.resolve(this.projectRoot, filename);
        if (fs.existsSync(abs)) {
          this.#deleted.delete(abs);
          this.#changed.add(abs);
        } else {
          this.#changed.delete(abs);
          this.#deleted.add(abs);
        }
      });
      this.#watcher.on("error", () => this.stop());
    } catch {
      // Watching is an optimization: without it queries still work, they just
      // see the snapshot as of the last explicit refresh.
      this.#watcher = undefined;
    }
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  get dirty(): boolean {
    return this.#changed.size > 0 || this.#deleted.size > 0;
  }

  /**
   * Apply any pending changes. Safe to call before every query — it returns
   * immediately when nothing is dirty, and concurrent callers share one pass.
   */
  async settle(): Promise<void> {
    if (!this.dirty) return;
    if (this.#applying) return this.#applying;

    this.#applying = this.#apply().finally(() => {
      this.#applying = undefined;
    });
    return this.#applying;
  }

  async #apply(): Promise<void> {
    const started = performance.now();
    const changed = [...this.#changed];
    const deleted = [...this.#deleted];
    this.#changed.clear();
    this.#deleted.clear();

    const result = await this.api.applyChanges({
      ...(changed.length ? { changed } : {}),
      ...(deleted.length ? { deleted } : {}),
    });

    for (const f of [...changed, ...deleted]) this.semantic?.invalidate(f);

    if (this.navigate) {
      if (result.deletedFiles.length > 0) this.navigate.forget(result.deletedFiles);
      if (result.changedFiles.length > 0) {
        await this.navigate.reindex(result.changedFiles);
      }
    }

    this.stats.refreshes++;
    this.stats.filesReindexed += result.changedFiles.length;
    this.stats.lastRefreshMs = performance.now() - started;
  }
}
