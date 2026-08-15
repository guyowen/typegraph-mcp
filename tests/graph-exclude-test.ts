/**
 * The module graph must honor the tsconfig's `exclude`.
 *
 * Two layers answer questions about a project and they scope themselves
 * differently. The semantic layer opens the tsconfig as a program, so
 * `exclude` is obeyed for free. The graph layer walks the filesystem from
 * TYPEGRAPH_PROJECT_ROOT and, before this test, consulted only a hardcoded
 * SKIP_DIRS set plus the tool's own directory — `excludedPaths` was never
 * populated from the tsconfig at all.
 *
 * The divergence is not cosmetic. A project that vendors a large dependency
 * under an excluded directory gets those files indexed as first-class graph
 * nodes: they appear in ts_dependents/ts_dependency_tree results and are
 * grouped under a package name that can collide with the real installed
 * dependency of the same name. Callers cannot tell the vendored copy from the
 * one that ships.
 *
 * Two `exclude` spellings carry that weight in practice:
 *
 *  - a plain relative path ("vendor") — the directory itself
 *  - a `**\/name` pattern ("**\/generated") — any directory with that name
 *
 * Anything richer is a real glob, which this walker has no matcher for. Those
 * are reported rather than silently half-applied, because an exclusion that
 * quietly does nothing is worse than one that says it did nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph, discoverFiles } from "../src/module-graph.ts";
import { removeTempTree } from "./test-fs.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-exclude-"));

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const write = (rel: string, body: string): string => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};

try {
  fs.writeFileSync(
    path.join(tmp, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", noEmit: true },
        include: ["src"],
        // node_modules and dist are already covered by SKIP_DIRS; they are here
        // so a fix cannot pass by accident on the entries that always worked.
        exclude: ["node_modules", "dist", "vendor", "plugins", "**/generated"],
      },
      null,
      2,
    ),
  );

  const kept = [write("src/index.ts", `export * from "./thing.ts";\n`), write("src/thing.ts", `export const alpha = 1;\n`)];
  const excluded = [
    write("vendor/lib/big.ts", `export const vendored = 1;\n`),
    write("plugins/p.ts", `export const plugin = 1;\n`),
    write("src/generated/gen.ts", `export const generated = 1;\n`),
  ];
  write("dist/stale.ts", `export const stale = 1;\n`);

  const { graph } = await buildGraph(tmp, "./tsconfig.json");
  const files = new Set([...graph.files].map((f) => fs.realpathSync(f)));
  const has = (abs: string): boolean => files.has(fs.realpathSync(abs));

  console.log(`\ntsconfig exclude honored by the graph (${files.size} files discovered)`);
  check("src/index.ts kept", has(kept[0]!));
  check("src/thing.ts kept", has(kept[1]!));
  check("vendor/ excluded (plain path)", !has(excluded[0]!));
  check("plugins/ excluded (plain path)", !has(excluded[1]!));
  check("src/generated/ excluded (**/name)", !has(excluded[2]!));

  // Regression guard: the caller-supplied excludedPaths is what keeps this
  // package's own sources out of a project that installs it. Reading the
  // tsconfig must add to that list, never replace it.
  const withCaller = discoverFiles(tmp, [path.join(tmp, "src")]);
  check("caller excludedPaths still applied", !withCaller.some((f) => f.includes(`${path.sep}src${path.sep}`)), `${withCaller.length} files`);

  // A project with no exclude, and one with no tsconfig at all, must still build.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tg-exclude-bare-"));
  try {
    fs.mkdirSync(path.join(bare, "src"));
    fs.writeFileSync(path.join(bare, "src/only.ts"), `export const only = 1;\n`);
    fs.writeFileSync(path.join(bare, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
    const noExclude = await buildGraph(bare, "./tsconfig.json");
    check("tsconfig without exclude still builds", noExclude.graph.files.size === 1, `${noExclude.graph.files.size} files`);

    fs.rmSync(path.join(bare, "tsconfig.json"));
    const noConfig = await buildGraph(bare, "./tsconfig.json");
    check("missing tsconfig still builds", noConfig.graph.files.size === 1, `${noConfig.graph.files.size} files`);
  } finally {
    removeTempTree(bare);
  }
} finally {
  removeTempTree(tmp);
}

console.log(failures === 0 ? "\nOK — graph honors tsconfig exclude" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
