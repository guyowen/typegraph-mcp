/**
 * Boots the MCP server over stdio as a real client would, lists its tools, and
 * exercises one from each backend.
 *
 * Usage: node tests/server-smoke.ts <projectRoot>
 */
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
const repoRoot = path.resolve(import.meta.dirname, "..");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, "src/server.cjs")],
  // Mirror normal agent launch: cwd is the project and the env pins the target.
  cwd: projectRoot,
  env: {
    ...(process.env as Record<string, string>),
    TYPEGRAPH_PROJECT_ROOT: projectRoot,
    TYPEGRAPH_TSCONFIG: "./tsconfig.json",
  },
});

const client = new Client({ name: "smoke", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools registered: ${tools.length}`);
const names = tools.map((t) => t.name).sort();
console.log(`  ${names.join(", ")}`);

const EXPECTED = 18;
let failures = 0;
const check = (label: string, ok: boolean, detail: string): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log("\nregistration");
check("all 18 tools present", tools.length === EXPECTED, `${tools.length}/${EXPECTED}`);

const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const res: any = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
};

console.log("\nsemantic backend (tsgo --api)");
const info = await call("ts_type_info", { file: "src/core/mod000.ts", symbol: "makeWidget0" });
check("ts_type_info returns a signature", String(info.type).includes("=>"), info.type);

const defs = await call("ts_definition", { file: "src/index.ts", symbol: "createPrimaryWidget" });
check(
  "ts_definition resolves the barrel alias",
  defs.definitions?.some((d: any) => d.file.endsWith("core/mod000.ts")),
  defs.definitions?.map((d: any) => path.basename(d.file)).join(",") ?? "none",
);

const exps = await call("ts_module_exports", { file: "src/core/mod000.ts" });
check("ts_module_exports lists 7", exps.count === 7, `${exps.count}`);
check("ts_module_exports includes kind metadata", typeof exps.exports?.[0]?.kind === "string", exps.exports?.[0]?.kind);

console.log("\nnavigate_to (export index)");
const nav = await call("ts_navigate_to", { symbol: "WidgetService" });
check("exact uncapped count", nav.exportHits === 1500, `exportHits=${nav.exportHits}`);
check("not truncated by default", nav.localsTruncated === false, `localsTruncated=${nav.localsTruncated}`);
check("navigate_to keeps old-friendly result aliases", nav.count === nav.totalHits && Array.isArray(nav.results), `count=${nav.count}`);

const navLocal = await call("ts_navigate_to", { symbol: "internalHelper", includeLocals: true });
check("includeLocals reaches non-exported symbols", navLocal.localHits > 0, `localHits=${navLocal.localHits}`);
check("and flags the cap", navLocal.localsTruncated === true, `warning present: ${!!navLocal.warning}`);

console.log("\ngraph backend (oxc)");
const cycles = await call("ts_import_cycles", {});
check("ts_import_cycles runs", cycles !== null && typeof cycles === "object", `cycles=${cycles.cycles?.length ?? 0}`);

const tree = await call("ts_dependency_tree", { file: "src/index.ts", depth: 1 });
check("ts_dependency_tree runs", tree !== null && typeof tree === "object", `files=${tree.files?.length ?? tree.count ?? "?"}`);

console.log("\nagent helper tools");
const projectInfo = await call("ts_project_info", {});
check("ts_project_info reports project files", projectInfo.semantic?.projectFiles > 0, `${projectInfo.semantic?.projectFiles ?? 0}`);

const docSymbols = await call("ts_document_symbols", { file: "src/core/mod000.ts", symbol: "makeWidget0" });
check("ts_document_symbols finds a symbol", docSymbols.count > 0, `${docSymbols.count}`);

const overview = await call("ts_symbol_overview", { file: "src/core/mod000.ts", symbol: "makeWidget0" });
check("ts_symbol_overview returns type info", typeof overview.typeInfo?.type === "string", overview.typeInfo?.type ?? "");

const deadExports = await call("ts_dead_exports", { file: "src/core/mod000.ts", maxResults: 3 });
check("ts_dead_exports checks exports", deadExports.checkedCount === 3, `${deadExports.checkedCount}`);

await client.close();
console.log(failures === 0 ? "\nOK — server wired end to end" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
