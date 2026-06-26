#!/usr/bin/env npx tsx

/**
 * Setup Install Test
 *
 * Verifies that `typegraph-mcp setup` copies all required files
 * and the server can start correctly.
 */

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function runTsx(cwd: string, args: string[]): string {
  const tsxPath = path.join(cwd, "node_modules/.bin/tsx");
  // If tsx not in cwd, use repoRoot's tsx
  const repoRoot = import.meta.dirname;
  const tsxFs = fs.existsSync(tsxPath)
    ? tsxPath
    : path.join(repoRoot, "node_modules/.bin/tsx");
  return execFileSync(tsxFs, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
    timeout: 30000,
  });
}

function assertIncludes(text: string, expected: string): void {
  assert.ok(
    text.includes(expected),
    `Expected output to include:\n${expected}\n\nActual output:\n${text}`,
  );
}

// ─── Required Files ──────────────────────────────────────────────────────────

const REQUIRED_CORE_FILES = [
  "server.ts",
  "module-graph.ts",
  "tsserver-client.ts",
  "graph-queries.ts",
  "config.ts",
  "check.ts",
  "smoke-test.ts",
  "cli.ts",
  "package.json",
  "export-resolver.ts",
  "tsconfig-patch.ts",
  "disk-cache.ts",
  "src/core/tsserver/client.ts",
  "src/core/tsserver/index.ts",
  "src/core/tsserver/types.ts",
  "src/core/graph/builder.ts",
  "src/core/graph/queries.ts",
  "src/core/graph/index.ts",
  "src/core/graph/types.ts",
  "src/core/index.ts",
  "src/shared/config.ts",
];

const REQUIRED_CLI_AGENTS_FILES = [
  "src/cli/agents/index.ts",
  "src/cli/agents/registry.ts",
  "src/cli/agents/toml-helpers.ts",
  "src/cli/agents/types.ts",
];

const REQUIRED_SERVER_FILES = [
  "src/server/index.ts",
  "src/server/types.ts",
  "src/server/navigation.ts",
  "src/server/graph.ts",
];

// ─── Test ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const repoRoot = import.meta.dirname;
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "typegraph-setup-test-"),
  );
  const projectRoot = path.join(tempRoot, "project");

  try {
    console.log("");
    console.log("typegraph-mcp Setup Install Test");
    console.log("================================");

    // Create minimal project
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "test-project", private: true, type: "module" }),
    );
    fs.writeFileSync(
      path.join(projectRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
        },
        include: ["src/**/*.ts"],
      }),
    );
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "src/index.ts"),
      "export const x = 1;\n",
    );

    // Symlink node_modules/typescript
    fs.mkdirSync(path.join(projectRoot, "node_modules"), { recursive: true });
    fs.symlinkSync(
      path.join(repoRoot, "node_modules/typescript"),
      path.join(projectRoot, "node_modules/typescript"),
      "dir",
    );

    console.log(`\nTemp dir: ${projectRoot}`);

    // Run setup with --yes
    console.log("\n── setup --yes ──────────────────────────────────────────");
    const cliPath = path.join(repoRoot, "cli.ts");
    const output = runTsx(projectRoot, [cliPath, "setup", "--yes"]);
    assertIncludes(output, "Installed");
    console.log("  ✓ setup completed");

    const pluginDir = path.join(projectRoot, "plugins/typegraph-mcp");
    assert.ok(fs.existsSync(pluginDir), "Plugin directory should exist");
    console.log("  ✓ plugins/typegraph-mcp/ exists");

    // Verify core files
    console.log("\n── Core files ──────────────────────────────────────────");
    for (const file of REQUIRED_CORE_FILES) {
      const filePath = path.join(pluginDir, file);
      assert.ok(fs.existsSync(filePath), `Missing core file: ${file}`);
    }
    console.log(`  ✓ All ${REQUIRED_CORE_FILES.length} core files present`);

    // Verify CLI agents files
    console.log("\n── CLI agents files ────────────────────────────────────");
    for (const file of REQUIRED_CLI_AGENTS_FILES) {
      const filePath = path.join(pluginDir, file);
      assert.ok(fs.existsSync(filePath), `Missing CLI agents file: ${file}`);
    }
    console.log(
      `  ✓ All ${REQUIRED_CLI_AGENTS_FILES.length} CLI agents files present`,
    );

    // Verify server files
    console.log("\n── Server files ────────────────────────────────────────");
    for (const file of REQUIRED_SERVER_FILES) {
      const filePath = path.join(pluginDir, file);
      assert.ok(fs.existsSync(filePath), `Missing server file: ${file}`);
    }
    console.log(`  ✓ All ${REQUIRED_SERVER_FILES.length} server files present`);

    // Verify agent configs
    console.log("\n── Agent configs ───────────────────────────────────────");
    const opencodePath = path.join(projectRoot, "opencode.json");
    const mimocodePath = path.join(projectRoot, "mimocode.json");
    assert.ok(fs.existsSync(opencodePath), "opencode.json should exist");
    assert.ok(fs.existsSync(mimocodePath), "mimocode.json should exist");

    const opencodeConfig = JSON.parse(fs.readFileSync(opencodePath, "utf-8"));
    assert.ok(
      opencodeConfig.mcp?.typegraph,
      "opencode.json should have mcp.typegraph",
    );

    const mimocodeConfig = JSON.parse(fs.readFileSync(mimocodePath, "utf-8"));
    assert.ok(
      mimocodeConfig.mcp?.typegraph,
      "mimocode.json should have mcp.typegraph",
    );

    console.log("  ✓ opencode.json has MCP registration");
    console.log("  ✓ mimocode.json has MCP registration");

    // Run health check
    console.log("\n── Health check ────────────────────────────────────────");
    const checkOutput = runTsx(projectRoot, [cliPath, "check"]);
    assert.ok(
      checkOutput.includes("checks passed"),
      `Health check should pass:\n${checkOutput}`,
    );
    assert.ok(
      !checkOutput.includes("1 failed"),
      `Health check should have no failures:\n${checkOutput}`,
    );
    console.log("  ✓ Health check passed");

    console.log("\nAll setup tests passed!");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
