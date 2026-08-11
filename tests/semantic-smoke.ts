/**
 * Exercises every point-query tool against the generated navtest fixture.
 * Usage: node tests/semantic-smoke.ts <projectRoot>
 */
import path from "node:path";
import { ApiClient } from "../src/api-client.ts";
import { SemanticService } from "../src/semantic.ts";

const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
const tsconfig = path.join(projectRoot, "tsconfig.json");
const rel = (f: string): string => path.relative(projectRoot, f);

const api = await ApiClient.create({ projectRoot, tsconfig });
const sem = new SemanticService(api);

const mod = path.join(projectRoot, "src/core/mod000.ts");
const barrel = path.join(projectRoot, "src/index.ts");

let failures = 0;
const check = (label: string, ok: boolean, detail: string): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log("ts_find_symbol");
const found = await sem.findSymbol(mod, "makeWidget0");
check("locates makeWidget0", !!found, found ? `${rel(found.file)}:${found.line}:${found.column}` : "not found");

console.log("\nts_type_info");
if (found) {
  const info = await sem.typeInfo(found.file, sem.locToOffset(found.file, found.line, found.column));
  check("resolves a function signature", info?.type?.includes("=>") ?? false, info?.type ?? "null");
}

const iface = await sem.findSymbol(mod, "Widget0");
if (iface) {
  const info = await sem.typeInfo(iface.file, sem.locToOffset(iface.file, iface.line, iface.column));
  check("interface uses declared type, not `any`", info?.type !== "any", `${info?.kind}: ${info?.type}`);
}

console.log("\nts_definition (through a renamed barrel re-export)");
// src/index.ts: export { makeWidget0 as createPrimaryWidget } from "./core/mod000.ts"
const barrelText = (await import("node:fs")).readFileSync(barrel, "utf-8");
const aliasOffset = barrelText.indexOf("createPrimaryWidget");
const defs = await sem.definition(barrel, aliasOffset);
check(
  "resolves alias to the origin module",
  defs.some((d) => d.file.endsWith("core/mod000.ts")),
  defs.map((d) => `${rel(d.file)}:${d.line}`).join(", ") || "none",
);

console.log("\nts_references");
if (found) {
  const refs = await sem.references(found.file, sem.locToOffset(found.file, found.line, found.column));
  check("finds references incl. the barrel", refs.length > 0, `${refs.length} refs across ${new Set(refs.map((r) => r.file)).size} files`);
}

console.log("\nts_module_exports");
const exps = await sem.moduleExports(mod);
check("lists exports with types", exps.length === 7, `${exps.length} exports`);
for (const e of exps.slice(0, 3)) console.log(`       ${e.name} : ${e.type}`);

console.log("\nts_trace_chain");
const chain = await sem.traceChain(barrel, aliasOffset, 5);
check("follows at least one hop", chain.length > 0, chain.map((h) => `${rel(h.file)}:${h.line}`).join(" -> ") || "none");

console.log("\nts_blast_radius");
if (found) {
  const blast = await sem.blastRadius(found.file, sem.locToOffset(found.file, found.line, found.column));
  check("groups usages by file", blast.filesAffected > 0, `${blast.totalReferences} refs across ${blast.filesAffected} files`);
}

await api.close();
console.log(failures === 0 ? "\nOK — all point queries working" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
