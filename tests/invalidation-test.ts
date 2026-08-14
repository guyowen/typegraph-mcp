/**
 * Live-edit invalidation, through the real MCP surface.
 *
 * Uses a throwaway project so the shared fixture is never mutated. Edits land
 * on disk exactly as an agent would make them; the server must see them without
 * a restart.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { removeTempTree } from "./test-fs.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-inval-"));

fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.mkdirSync(path.join(tmp, "node_modules"), { recursive: true });
fs.symlinkSync(
  path.join(repoRoot, "node_modules", "typescript"),
  path.join(tmp, "node_modules", "typescript"),
  process.platform === "win32" ? "junction" : "dir",
);
fs.writeFileSync(
  path.join(tmp, "tsconfig.json"),
  JSON.stringify(
    { compilerOptions: { strict: true, module: "nodenext", moduleResolution: "nodenext", noEmit: true }, include: ["src"] },
    null,
    2,
  ),
);
const target = path.join(tmp, "src/thing.ts");
fs.writeFileSync(target, `export const alpha = 1;\n`);
fs.writeFileSync(path.join(tmp, "src/index.ts"), `export * from "./thing.ts";\n`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, "src/server.cjs")],
  env: {
    ...(process.env as Record<string, string>),
    TYPEGRAPH_PROJECT_ROOT: tmp,
    TYPEGRAPH_TSCONFIG: "./tsconfig.json",
  },
});
const client = new Client({ name: "inval", version: "0.1.0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const res: any = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
};

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

// fs.watch delivers asynchronously; give the event loop a beat to see it.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

console.log("baseline");
const before = await call("ts_navigate_to", { symbol: "alpha" });
check("finds the original export", before.exportHits === 1, `exportHits=${before.exportHits}`);
const missing = await call("ts_navigate_to", { symbol: "bravo" });
check("does not yet see an unwritten symbol", missing.exportHits === 0, `exportHits=${missing.exportHits}`);

console.log("\nafter adding an export");
fs.writeFileSync(target, `export const alpha = 1;\nexport const bravo = "two";\n`);
await settle();
const added = await call("ts_navigate_to", { symbol: "bravo" });
check("new export visible without restart", added.exportHits === 1, `exportHits=${added.exportHits}`);

const typed = await call("ts_type_info", { file: "src/thing.ts", symbol: "bravo" });
check("and the checker sees its type", typed.type === '"two"', String(typed.type));

console.log("\nafter changing a type");
fs.writeFileSync(target, `export const alpha = 1;\nexport const bravo = 99;\n`);
await settle();
const retyped = await call("ts_type_info", { file: "src/thing.ts", symbol: "bravo" });
check("type reflects the edit", retyped.type === "99", String(retyped.type));

console.log("\nafter removing an export");
fs.writeFileSync(target, `export const alpha = 1;\n`);
await settle();
const removed = await call("ts_navigate_to", { symbol: "bravo" });
check("stale entry dropped from the index", removed.exportHits === 0, `exportHits=${removed.exportHits}`);
const survivor = await call("ts_navigate_to", { symbol: "alpha" });
check("untouched export still indexed", survivor.exportHits === 1, `exportHits=${survivor.exportHits}`);

await client.close();
removeTempTree(tmp);
console.log(failures === 0 ? "\nOK — live edits propagate" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
