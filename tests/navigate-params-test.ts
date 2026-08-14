/**
 * ts_navigate_to's `file` and `maxResults` parameters, against a real program.
 *
 * Both exist to solve problems the index alone cannot:
 *
 *  - `file` reaches object-literal property keys. Measured on 7.0.2: a handler
 *    map yields ONE workspace/symbol hit (the binding) and ten documentSymbol
 *    hits (every key). RPC maps and route tables are written that way, so
 *    without the hint they are simply unfindable by name.
 *
 *  - `maxResults` trims the LIST without touching the COUNTS. That separation
 *    is the whole point: ts_navigate_to doubles as a prevalence-counting
 *    instrument for the deep-survey skill, and a cap that silently shrank
 *    exportHits would reintroduce the exact hazard the 256-cap analysis
 *    rejected the LSP-primary design over.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiClient } from "../src/api-client.ts";
import { NavigateTo, DEFAULT_MAX_RESULTS } from "../src/navigate-to.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-nav-"));
const repoRoot = path.resolve(import.meta.dirname, "..");

fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }, null, 2),
);
// getExePath resolves `typescript` from cwd, so the fixture needs its own.
fs.mkdirSync(path.join(tmp, "node_modules"), { recursive: true });
fs.symlinkSync(
  path.join(repoRoot, "node_modules/typescript"),
  path.join(tmp, "node_modules/typescript"),
  process.platform === "win32" ? "junction" : "dir",
);

// 25 exported symbols containing "Widget", one of them named exactly "Widget".
const decls = ["export interface Widget { id: string }"];
for (let i = 0; i < 24; i++) decls.push(`export const makeWidget${i} = (): number => ${i};`);
fs.writeFileSync(path.join(tmp, "src/widgets.ts"), decls.join("\n") + "\n");

// The case the `file` hint exists for.
fs.writeFileSync(
  path.join(tmp, "src/handlers.ts"),
  `export const rpcHandlers = {
  getWidgetProfile: (id: string) => ({ id }),
  deleteWidgetDraft: (id: string) => id,
  nested: {
    innerWidgetOp: () => 1,
  },
};
`,
);

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

// The binary lookup is cwd-relative; see api-client.ts.
process.chdir(tmp);

const api = await ApiClient.create({ projectRoot: tmp, tsconfig: path.join(tmp, "tsconfig.json") });
const nav = new NavigateTo(api);
const stats = await nav.buildIndex();
console.log(`indexed ${stats.indexedFiles} files, ${stats.uniqueSymbols} unique symbols\n`);

try {
  console.log("maxResults trims the list, never the counts");
  const capped = await nav.query("Widget", { maxResults: 5 });
  check("returns exactly maxResults", capped.hits.length === 5, `${capped.hits.length}`);
  check("exportHits stays exact", capped.exportHits === 25, `${capped.exportHits}`);
  check("totalHits stays exact", capped.totalHits === 25, `${capped.totalHits}`);
  check("listTrimmed set", capped.listTrimmed === true);

  const uncapped = await nav.query("Widget", { maxResults: 1000 });
  check("uncapped returns all", uncapped.hits.length === 25, `${uncapped.hits.length}`);
  check("listTrimmed clear when nothing dropped", uncapped.listTrimmed === false);
  check(
    "counts identical either way",
    uncapped.exportHits === capped.exportHits && uncapped.totalHits === capped.totalHits,
  );

  console.log("\ndefault applies when omitted");
  const dflt = await nav.query("Widget");
  check(`defaults to ${DEFAULT_MAX_RESULTS}`, dflt.hits.length === DEFAULT_MAX_RESULTS, `${dflt.hits.length}`);
  check("and still reports the true total", dflt.totalHits === 25, `${dflt.totalHits}`);

  console.log("\nranking makes the trim defensible");
  const exact = await nav.query("Widget", { maxResults: 1 });
  check("exact match survives a 1-result cap", exact.hits[0]?.name === "Widget");
  check("exact export hit carries a 1-based line", (exact.hits[0]?.line ?? 0) === 1, `line ${exact.hits[0]?.line}`);
  check("exact export hit carries kind", typeof exact.hits[0]?.kind === "string", exact.hits[0]?.kind ?? "");
  check("exact export hit carries matchKind", exact.hits[0]?.matchKind === "exact", exact.hits[0]?.matchKind ?? "");
  const prefixed = await nav.query("makeWidget1", { maxResults: 3 });
  check(
    "exact beats longer substring matches",
    prefixed.hits[0]?.name === "makeWidget1",
    prefixed.hits.map((h) => h.name).join(", "),
  );

  console.log("\nfile hint reaches object-literal keys");
  const without = await nav.query("getWidgetProfile", { maxResults: 50 });
  check("invisible to the export index alone", without.totalHits === 0, `${without.totalHits} hits`);

  const withHint = await nav.query("getWidgetProfile", { file: "src/handlers.ts", maxResults: 50 });
  check("found via the file hint", withHint.totalHits === 1, `${withHint.totalHits} hits`);
  check("counted as a navbar hit", withHint.navbarHits === 1, `${withHint.navbarHits}`);
  check("tagged via=navbar", withHint.hits[0]?.via === "navbar", withHint.hits[0]?.via);
  check("carries its container", withHint.hits[0]?.container === "rpcHandlers", withHint.hits[0]?.container);
  check("carries a 1-based line", (withHint.hits[0]?.line ?? 0) === 2, `line ${withHint.hits[0]?.line}`);

  const nested = await nav.query("innerWidgetOp", { file: "src/handlers.ts", maxResults: 50 });
  check("reaches a nested object literal too", nested.navbarHits === 1, `${nested.navbarHits}`);

  console.log("\nfile hint composes with the index");
  const both = await nav.query("Widget", { file: "src/handlers.ts", maxResults: 100 });
  check("index hits still exact", both.exportHits === 25, `${both.exportHits}`);
  check("navbar adds the handler keys", both.navbarHits >= 3, `${both.navbarHits}`);
  check("total is the sum", both.totalHits === both.exportHits + both.navbarHits, `${both.totalHits}`);
  check("source reports both", both.source === "both", both.source);

  console.log("\na bad file hint degrades, it does not throw");
  const missing = await nav.query("Widget", { file: "src/does-not-exist.ts", maxResults: 100 });
  check("index half unaffected", missing.exportHits === 25, `${missing.exportHits}`);
  check("no navbar hits", missing.navbarHits === 0, `${missing.navbarHits}`);
} finally {
  await nav.close();
  await api.close();
  process.chdir(repoRoot);
  // Windows can retain the compiler's directory handle for a few milliseconds
  // after the awaited shutdown. Retry only transient recursive-removal errors.
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(failures === 0 ? "\nOK — file and maxResults behave" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
