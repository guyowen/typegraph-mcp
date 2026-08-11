/**
 * Measures what a snapshot refresh actually costs, to decide whether
 * invalidation needs to be incremental or can just re-snapshot.
 *
 * Usage: node tests/refresh-bench.ts <projectRoot>
 */
import fs from "node:fs";
import path from "node:path";
import { ApiClient } from "../src/api-client.ts";
import { NavigateTo } from "../src/navigate-to.ts";

const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
const tsconfig = path.join(projectRoot, "tsconfig.json");
const victim = path.join(projectRoot, "src/core/mod000.ts");
const original = fs.readFileSync(victim, "utf-8");

const ms = (n: number): string => `${n.toFixed(1)}ms`;
const time = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  return [await fn(), performance.now() - t];
};

const api = await ApiClient.create({ projectRoot, tsconfig });
const files = await api.projectFiles();
console.log(`project: ${files.length} files\n`);

const nav = new NavigateTo(api);
const [stats] = await time(() => nav.buildIndex());
console.log(`initial index build:            ${ms(stats.elapsedMs)}  (${stats.totalSymbols} entries)`);

try {
  // Edit a file on disk, as an agent would.
  fs.writeFileSync(victim, original + "\nexport const addedByBench = 42;\n");

  const [, fullMs] = await time(() => api.refresh());
  console.log(`refresh() full re-snapshot:     ${ms(fullMs)}`);

  const [changes, incMs] = await time(() =>
    api.applyChanges({ changed: [victim] }),
  );
  console.log(`applyChanges({changed:[1]}):    ${ms(incMs)}`);
  const changed = changes?.changedFiles ?? [];
  console.log(`  reported changed files: ${changed.length}${changed.length ? ` (${path.basename(changed[0]!)}…)` : ""}`);

  const [, reindexMs] = await time(() => nav.reindex(changed.length ? changed : [victim]));
  console.log(`reindex(changedFiles):          ${ms(reindexMs)}`);

  const [rebuild] = await time(() => nav.buildIndex());
  console.log(`full index rebuild (for ref):   ${ms(rebuild.elapsedMs)}`);

  const hit = nav.queryIndex("addedByBench");
  console.log(`\nnew symbol visible after incremental path: ${hit.length > 0 ? "YES" : "NO"}`);
} finally {
  fs.writeFileSync(victim, original);
  await nav.close();
  await api.close();
}
