/**
 * End-to-end smoke test: does typescript/unstable/async actually drive the
 * @effect/tsgo binary, and does the hybrid navigate_to behave as benchmarked?
 *
 * Usage: node tests/api-smoke.ts <projectRoot> [tsconfig]
 */
import path from "node:path";
import { ApiClient } from "../src/api-client.ts";
import { NavigateTo, truncationNotice } from "../src/navigate-to.ts";

const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
const tsconfig = path.resolve(process.argv[3] ?? path.join(projectRoot, "tsconfig.json"));

const t = (label: string, ms: number): string => `${label}: ${ms.toFixed(1)}ms`;

const bootStart = performance.now();
const api = await ApiClient.create({ projectRoot, tsconfig });
console.log(t("boot + snapshot", performance.now() - bootStart));
console.log(`  binary: ${api.exe?.source} -> ${path.basename(api.exe?.path ?? "?")}`);

const files = await api.projectFiles();
console.log(`  project files: ${files.length}`);

const nav = new NavigateTo(api);
const stats = await nav.buildIndex();
console.log(
  t("index build", stats.elapsedMs) +
    `  -> ${stats.totalSymbols} entries, ${stats.uniqueSymbols} unique` +
    ` (${(stats.elapsedMs / Math.max(stats.indexedFiles, 1)).toFixed(3)} ms/file)` +
    (stats.errors ? `  errors=${stats.errors}` : ""),
);

const queries = process.env.TYPEGRAPH_QUERIES?.split(",") ?? [
  "WidgetService",
  "internalHelper",
  "Widget",
];

for (const q of queries) {
  const s = performance.now();
  const exportsOnly = await nav.query(q);
  const withLocals = await nav.query(q, { includeLocals: true });
  console.log(
    `  ${q.padEnd(18)} exports=${String(exportsOnly.hits.length).padStart(5)}` +
      `  +locals=${String(withLocals.hits.length).padStart(5)}` +
      `  truncated=${withLocals.localsTruncated}` +
      `  (${(performance.now() - s).toFixed(1)}ms)`,
  );
  const notice = truncationNotice(withLocals);
  if (notice) console.log(`      ! ${notice.split(".")[0]}.`);
}

// Prove the checker itself is reachable, not just the program.
const first = files[0];
if (first) {
  const sym = await api.moduleSymbol(first);
  if (sym) {
    const exports = await api.checker.getExportsOfModule(sym);
    console.log(`\nchecker reachable: ${path.basename(first)} exports ${exports.length} symbols`);
    // SymbolFlags: Interface=64, TypeAlias=524288, Class=32. Type-only symbols
    // have no value type — getTypeOfSymbol returns `any` for them, which is
    // correct but useless to display. Use the declared type instead.
    const TYPE_ONLY = 64 | 524288;
    for (const sym of exports.slice(0, 3)) {
      const type =
        (sym.flags & TYPE_ONLY) !== 0
          ? await api.checker.getDeclaredTypeOfSymbol(sym)
          : await api.checker.getTypeOfSymbol(sym);
      const str = await api.checker.typeToString(type);
      console.log(`  ${sym.name} : ${str}`);
    }
  }
}

await nav.close();
await api.close();
console.log("\nOK");
