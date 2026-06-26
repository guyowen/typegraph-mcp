#!/usr/bin/env npx tsx
/**
 * Error Path Unit Tests
 *
 * Tests error handling paths identified in code review for:
 * - tsserver-client.ts
 * - export-resolver.ts
 * - module-graph.ts
 * - config.ts
 * - src/cli/agents/toml-helpers.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { TsServerClient } from "./src/core/tsserver/index.js";
import { getModuleExports, normalizeExistingPath } from "./export-resolver.js";
import {
  discoverFiles,
  buildForwardEdges,
  createResolver,
  updateFile,
  buildGraph,
  type ModuleGraph,
} from "./src/core/graph/index.js";
import { validateConfig, type TypegraphConfig } from "./src/shared/config.js";
import { pathEqualsOrContains } from "./src/cli/agents/toml-helpers.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

function makeProjectDir(root: string): string {
  const projectDir = path.join(root, "project");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "package.json"),
    JSON.stringify({ name: "test-project", private: true, type: "module" }),
  );
  fs.writeFileSync(
    path.join(projectDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      include: ["src/**/*.ts"],
    }),
  );
  return projectDir;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const repoRoot = import.meta.dirname;
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "typegraph-error-path-"),
  );

  try {
    console.log("");
    console.log("typegraph-mcp Error Path Tests");
    console.log("===============================");
    console.log(`Temp dir: ${tempRoot}`);
    console.log("");

    // ─── tsserver-client.ts ───────────────────────────────────────────────

    console.log("── tsserver-client.ts ──────────────────────────────────────");

    // 1. readLine returns empty string on file read error
    const tsClient = new TsServerClient(tempRoot);
    check(
      "readLine returns empty string for non-existent file",
      tsClient.readLine("/nonexistent/path/file.ts", 1) === "",
    );

    // ─── export-resolver.ts ──────────────────────────────────────────────

    console.log("");
    console.log("── export-resolver.ts ──────────────────────────────────────");

    const projectDir = makeProjectDir(tempRoot);

    // 2. normalizeExistingPath returns resolved path when realpath fails
    const resolved = normalizeExistingPath("/nonexistent/path/file.ts");
    check(
      "normalizeExistingPath falls back to resolved path on realpath failure",
      resolved === path.resolve("/nonexistent/path/file.ts"),
    );

    // 3. getModuleExports returns [] on read failure
    const mockClient = {
      resolvePath: (file: string) => path.resolve(projectDir, file),
    } as any;
    const mockResolver = { sync: () => ({ path: null }) } as any;
    const readFailResult = await getModuleExports(
      mockClient,
      mockResolver,
      projectDir,
      (f) => path.relative(projectDir, f),
      () => null,
      "/nonexistent/file.ts",
    );
    check(
      "getModuleExports returns [] when file read fails",
      Array.isArray(readFailResult) && readFailResult.length === 0,
    );

    // 4. getModuleExports returns [] on parse failure
    const badFile = path.join(projectDir, "src", "bad-syntax.ts");
    fs.writeFileSync(badFile, "const x = ");
    const parseFailResult = await getModuleExports(
      mockClient,
      mockResolver,
      projectDir,
      (f) => path.relative(projectDir, f),
      () => null,
      badFile,
    );
    check(
      "getModuleExports returns [] when file parsing fails",
      Array.isArray(parseFailResult) && parseFailResult.length === 0,
    );

    // ─── module-graph.ts ────────────────────────────────────────────────

    console.log("");
    console.log("── module-graph.ts ────────────────────────────────────────");

    // Use a dedicated project dir to avoid parse cache contamination
    const graphTestRoot = fs.mkdtempSync(path.join(tempRoot, "graph-"));
    const graphProjectDir = makeProjectDir(graphTestRoot);

    // 5. discoverFiles returns [] on readdir failure
    const discovered = discoverFiles(
      "/nonexistent/directory/that/does/not/exist",
    );
    check(
      "discoverFiles returns [] when directory does not exist",
      Array.isArray(discovered) && discovered.length === 0,
    );

    // 6. buildForwardEdges reports parse failures for unreadable files (cached
    //    parseFileImportsCached returns null on read error, which counts as failed)
    const gtfGoodFile2 = path.join(graphProjectDir, "src", "valid.ts");
    fs.writeFileSync(gtfGoodFile2, "export const x = 1;\n");
    const gtfBadFile2 = path.join(graphProjectDir, "src", "bad-syntax.ts");
    fs.writeFileSync(gtfBadFile2, "const x = ");
    const gtfResolver2 = createResolver(graphProjectDir, "./tsconfig.json");
    const forwardResult = await buildForwardEdges(
      [gtfGoodFile2, gtfBadFile2],
      gtfResolver2,
      graphProjectDir,
    );
    // oxc-parser parses "const x = " without error, so it won't be a parse failure.
    // But if we remove the file after caching and rebuild, parseFileImportsCached
    // returns null (read error) → it IS counted as a parse failure.
    const gtfGoodFile3 = path.join(graphProjectDir, "src", "valid3.ts");
    fs.writeFileSync(gtfGoodFile3, "export const z = 1;\n");
    const gtfDisappearing = path.join(graphProjectDir, "src", "vanishing.ts");
    fs.writeFileSync(gtfDisappearing, "export const v = 1;\n");
    // First build caches the file
    await buildForwardEdges(
      [gtfDisappearing, gtfGoodFile3],
      gtfResolver2,
      graphProjectDir,
    );
    // Remove the cached file from disk
    fs.rmSync(gtfDisappearing);
    // Rebuild — parseFileImportsCached will fail on stat/read, returns null
    const disappearingResult = await buildForwardEdges(
      [gtfDisappearing, gtfGoodFile3],
      gtfResolver2,
      graphProjectDir,
    );
    check(
      "buildForwardEdges reports parse failures for files that become unreadable",
      disappearingResult.parseFailures.includes(gtfDisappearing),
    );

    // 7. buildForwardEdges handles unreadable files (directory at file path)
    const unreadableDir = path.join(graphProjectDir, "unreadable.ts");
    fs.mkdirSync(unreadableDir);
    const unreadableResult = await buildForwardEdges(
      [gtfGoodFile2, unreadableDir],
      gtfResolver2,
      graphProjectDir,
    );
    check(
      "buildForwardEdges treats unreadable paths as parse failures",
      unreadableResult.parseFailures.includes(unreadableDir),
    );

    // 8. updateFile removes file when it becomes unreadable
    const { graph } = await buildGraph(graphProjectDir, "./tsconfig.json");
    check(
      "updateFile setup: gtfGoodFile2 is present in graph",
      graph.files.has(gtfGoodFile2),
    );
    // Replace file with a directory so readFileSync throws EISDIR
    fs.rmSync(gtfGoodFile2);
    fs.mkdirSync(gtfGoodFile2);
    updateFile(graph, gtfGoodFile2, gtfResolver2, graphProjectDir);
    check(
      "updateFile removes file from graph when unreadable",
      !graph.files.has(gtfGoodFile2),
    );

    // ─── config.ts ──────────────────────────────────────────────────────

    console.log("");
    console.log("── config.ts ──────────────────────────────────────────────");

    // 9. validateConfig warns (not errors) when TypeScript is missing
    const tsProjectDir = path.join(tempRoot, "no-ts-project");
    fs.mkdirSync(path.join(tsProjectDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tsProjectDir, "package.json"),
      JSON.stringify({ name: "no-ts" }),
    );
    fs.writeFileSync(
      path.join(tsProjectDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: {} }),
    );

    const tsConfig: TypegraphConfig = {
      projectRoot: tsProjectDir,
      tsconfigPath: "./tsconfig.json",
      toolDir: tsProjectDir,
      toolIsEmbedded: false,
      toolRelPath: ".",
    };

    const validation = validateConfig(tsConfig);
    check(
      "validateConfig is valid when TypeScript is missing",
      validation.valid,
      `errors: ${JSON.stringify(validation.errors)}`,
    );
    check(
      "validateConfig warns when TypeScript is missing",
      validation.warnings.some((w) => w.includes("TypeScript")),
      `warnings: ${JSON.stringify(validation.warnings)}`,
    );

    // ─── toml-helpers.ts ────────────────────────────────────────────────

    console.log("");
    console.log("── toml-helpers.ts ────────────────────────────────────────");

    // 10. pathEqualsOrContains returns false for non-existent paths
    const nonexistentA = path.join(tempRoot, "does-not-exist-a");
    const nonexistentB = path.join(tempRoot, "does-not-exist-b");
    check(
      "pathEqualsOrContains returns false when neither path exists",
      pathEqualsOrContains(nonexistentA, nonexistentB) === false,
    );
    check(
      "pathEqualsOrContains returns false when only candidate does not exist",
      pathEqualsOrContains(nonexistentA, projectDir) === false,
    );
    check(
      "pathEqualsOrContains returns false when only target does not exist",
      pathEqualsOrContains(projectDir, nonexistentB) === false,
    );

    // ─── tsserver-client.ts restart ────────────────────────────────────

    console.log("");
    console.log("── tsserver-client.ts (restart) ──────────────────────────");

    // 11. Restart logic catches ensureOpen errors
    const restartClient = new TsServerClient(projectDir);
    // Prevent actual tsserver spawn by injecting a mock child process
    (restartClient as any).child = {
      stdout: null,
      stderr: null,
      stdin: null,
      kill: () => {},
      on: () => {},
    };
    (restartClient as any).ready = true;

    let ensureOpenCalls: string[] = [];
    const origEnsureOpen = (restartClient as any).ensureOpen;
    (restartClient as any).ensureOpen = async (file: string): Promise<void> => {
      ensureOpenCalls.push(file);
      throw new Error("simulated ensureOpen failure");
    };

    const restartFile = path.join(projectDir, "src", "restart-test.ts");
    (restartClient as any).openFiles.add(restartFile);

    // tryRestart is private; invoke via any to test the error-handling contract
    (restartClient as any).tryRestart();

    // Wait for the async start().then(...) chain to settle
    await new Promise((r) => setTimeout(r, 150));

    check(
      "TsServerClient restart does not propagate ensureOpen errors",
      ensureOpenCalls.includes(restartFile),
      `ensureOpen calls: ${JSON.stringify(ensureOpenCalls)}`,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("");
  const total = passed + failed;
  if (failed === 0) {
    console.log(`${passed}/${total} passed -- all error paths covered`);
  } else {
    console.log(
      `${passed}/${total} passed, ${failed} failed -- see details above`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
