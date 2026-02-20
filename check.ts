#!/usr/bin/env npx tsx
/**
 * typegraph-mcp Health Check — Verifies all setup requirements are met.
 *
 * Run from project root:
 *   npx tsx tools/typegraph-mcp/check.ts
 *
 * Or from tools/typegraph-mcp/:
 *   pnpm check
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

// ─── Configuration ───────────────────────────────────────────────────────────

// Tool directory is wherever this script lives
const toolDir = import.meta.dirname;

// Detect project root:
//   1. TYPEGRAPH_PROJECT_ROOT env var (explicit)
//   2. If check.ts is inside tools/typegraph-mcp/, go up two levels
//   3. Otherwise, use cwd (standalone deployment, run from target project)
const cwd = process.cwd();
const projectRoot = process.env["TYPEGRAPH_PROJECT_ROOT"]
  ? path.resolve(cwd, process.env["TYPEGRAPH_PROJECT_ROOT"])
  : path.basename(path.dirname(toolDir)) === "tools"
    ? path.resolve(toolDir, "../..")
    : cwd;

const tsconfigPath = process.env["TYPEGRAPH_TSCONFIG"] || "./tsconfig.json";

// Is typegraph-mcp embedded inside the project (e.g. tools/typegraph-mcp/)?
const toolIsEmbedded = toolDir.startsWith(projectRoot + path.sep);
const toolRelPath = toolIsEmbedded ? path.relative(projectRoot, toolDir) : toolDir;

// ─── Test Harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let warned = 0;

function pass(msg: string): void {
  console.log(`  \u2713 ${msg}`);
  passed++;
}

function fail(msg: string, fix: string): void {
  console.log(`  \u2717 ${msg}`);
  console.log(`    Fix: ${fix}`);
  failed++;
}

function warn(msg: string, note: string): void {
  console.log(`  ! ${msg}`);
  console.log(`    ${note}`);
  warned++;
}

function skip(msg: string): void {
  console.log(`  - ${msg} (skipped)`);
}

// ─── Checks ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("typegraph-mcp Health Check");
  console.log("=======================");
  console.log(`Project root: ${projectRoot}`);
  console.log("");

  // 1. Node.js version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split(".")[0]!, 10);
  if (nodeMajor >= 18) {
    pass(`Node.js ${nodeVersion} (>= 18 required)`);
  } else {
    fail(`Node.js ${nodeVersion} is too old`, "Upgrade Node.js to >= 18");
  }

  // 2. tsx availability (if we're running, tsx works — but check it's in the project)
  const tsxInRoot = fs.existsSync(path.join(projectRoot, "node_modules/.bin/tsx"));
  const tsxInTool = fs.existsSync(path.join(toolDir, "node_modules/.bin/tsx"));
  if (tsxInRoot || tsxInTool) {
    pass(`tsx available (in ${tsxInRoot ? "project" : "tool"} node_modules)`);
  } else {
    // We're running via tsx, so it must be available somehow (global or npx)
    pass("tsx available (via npx/global)");
  }

  // 3. TypeScript in project
  let tsVersion: string | null = null;
  try {
    const require = createRequire(path.resolve(projectRoot, "package.json"));
    const tsserverPath = require.resolve("typescript/lib/tsserver.js");
    const tsPkgPath = path.resolve(path.dirname(tsserverPath), "..", "package.json");
    const tsPkg = JSON.parse(fs.readFileSync(tsPkgPath, "utf-8"));
    tsVersion = tsPkg.version;
    pass(`TypeScript found (v${tsVersion})`);
  } catch {
    fail(
      "TypeScript not found in project",
      "Add `typescript` to devDependencies and run `pnpm install`"
    );
  }

  // 4. tsconfig.json exists
  const tsconfigAbs = path.resolve(projectRoot, tsconfigPath);
  if (fs.existsSync(tsconfigAbs)) {
    pass(`tsconfig.json exists at ${tsconfigPath}`);
  } else {
    fail(`tsconfig.json not found at ${tsconfigPath}`, `Create a tsconfig.json at ${tsconfigPath}`);
  }

  // 5. MCP registration
  const mcpJsonPath = path.resolve(projectRoot, ".claude/mcp.json");
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      const tsNav = mcpJson?.mcpServers?.["typegraph"];
      if (tsNav) {
        const hasCommand = tsNav.command === "npx";
        const hasArgs = Array.isArray(tsNav.args) && tsNav.args.includes("tsx");
        const hasEnv = tsNav.env?.["TYPEGRAPH_PROJECT_ROOT"] && tsNav.env?.["TYPEGRAPH_TSCONFIG"];
        if (hasCommand && hasArgs && hasEnv) {
          pass("MCP registered in .claude/mcp.json");
        } else {
          const issues: string[] = [];
          if (!hasCommand) issues.push("command should be 'npx'");
          if (!hasArgs) issues.push("args should include 'tsx'");
          if (!hasEnv) issues.push("env should set TYPEGRAPH_PROJECT_ROOT and TYPEGRAPH_TSCONFIG");
          fail(
            `MCP registration incomplete: ${issues.join(", ")}`,
            "See README for correct .claude/mcp.json format"
          );
        }
      } else {
        const serverPath = toolIsEmbedded
          ? `./${toolRelPath}/server.ts`
          : path.resolve(toolDir, "server.ts");
        fail(
          "MCP entry 'typegraph' not found in .claude/mcp.json",
          `Add to .claude/mcp.json:\n` +
            `    {\n` +
            `      "mcpServers": {\n` +
            `        "typegraph": {\n` +
            `          "command": "npx",\n` +
            `          "args": ["tsx", "${serverPath}"],\n` +
            `          "env": { "TYPEGRAPH_PROJECT_ROOT": ".", "TYPEGRAPH_TSCONFIG": "./tsconfig.json" }\n` +
            `        }\n` +
            `      }\n` +
            `    }`
        );
      }
    } catch (err) {
      fail(
        "Failed to parse .claude/mcp.json",
        `Check JSON syntax: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    fail(".claude/mcp.json not found", `Create .claude/mcp.json with typegraph server registration`);
  }

  // 6. typegraph-mcp dependencies installed
  const toolNodeModules = path.join(toolDir, "node_modules");
  if (fs.existsSync(toolNodeModules)) {
    const requiredPkgs = ["@modelcontextprotocol/sdk", "oxc-parser", "oxc-resolver", "zod"];
    const missing = requiredPkgs.filter(
      (pkg) => !fs.existsSync(path.join(toolNodeModules, ...pkg.split("/")))
    );
    if (missing.length === 0) {
      pass(`Dependencies installed (${requiredPkgs.length} packages)`);
    } else {
      fail(`Missing packages: ${missing.join(", ")}`, `Run \`cd ${toolRelPath} && pnpm install\``);
    }
  } else {
    fail("typegraph-mcp dependencies not installed", `Run \`cd ${toolRelPath} && pnpm install\``);
  }

  // 7. oxc-parser smoke test
  try {
    const oxcParserReq = createRequire(path.join(toolDir, "package.json"));
    const { parseSync } = await import(oxcParserReq.resolve("oxc-parser"));
    const result = parseSync("test.ts", 'import { x } from "./y";');
    if (result.module?.staticImports?.length === 1) {
      pass("oxc-parser working");
    } else {
      fail(
        "oxc-parser parseSync returned unexpected result",
        `Reinstall: \`cd ${toolRelPath} && rm -rf node_modules && pnpm install\``
      );
    }
  } catch (err) {
    fail(
      `oxc-parser failed: ${err instanceof Error ? err.message : String(err)}`,
      `Reinstall: \`cd ${toolRelPath} && rm -rf node_modules && pnpm install\``
    );
  }

  // 8. oxc-resolver smoke test
  try {
    const oxcResolverReq = createRequire(path.join(toolDir, "package.json"));
    const { ResolverFactory } = await import(oxcResolverReq.resolve("oxc-resolver"));
    const resolver = new ResolverFactory({
      tsconfig: { configFile: tsconfigAbs, references: "auto" },
      extensions: [".ts", ".tsx", ".js"],
      extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
    });
    // Try to resolve the tsconfig itself as a sanity check
    // Find any .ts file in the project to test resolution
    let resolveOk = false;
    const testFile = findFirstTsFile(projectRoot);
    if (testFile) {
      const dir = path.dirname(testFile);
      const base = "./" + path.basename(testFile);
      const result = resolver.sync(dir, base);
      resolveOk = !!result.path;
    }
    if (resolveOk) {
      pass("oxc-resolver working");
    } else {
      // Resolver loaded but couldn't resolve — still partially working
      warn(
        "oxc-resolver loaded but couldn't resolve a test import",
        "Check tsconfig.json is valid and has correct `references`"
      );
    }
  } catch (err) {
    fail(
      `oxc-resolver failed: ${err instanceof Error ? err.message : String(err)}`,
      `Reinstall: \`cd ${toolRelPath} && rm -rf node_modules && pnpm install\``
    );
  }

  // 9. tsserver startup test
  if (tsVersion) {
    try {
      const ok = await testTsserver();
      if (ok) {
        pass("tsserver responds to configure");
      } else {
        fail(
          "tsserver did not respond",
          "Verify `typescript` is installed and tsconfig.json is valid"
        );
      }
    } catch (err) {
      fail(
        `tsserver failed to start: ${err instanceof Error ? err.message : String(err)}`,
        "Verify `typescript` is installed and tsconfig.json is valid"
      );
    }
  } else {
    skip("tsserver test (TypeScript not found)");
  }

  // 10. Module graph build test
  try {
    const { buildGraph } = await import(path.resolve(toolDir, "module-graph.js"));
    const start = performance.now();
    const { graph } = await buildGraph(projectRoot, tsconfigPath);
    const elapsed = (performance.now() - start).toFixed(0);
    const edgeCount = [...graph.forward.values()].reduce(
      (s: number, e: unknown[]) => s + e.length,
      0
    );
    if (graph.files.size > 0 && edgeCount > 0) {
      pass(`Module graph: ${graph.files.size} files, ${edgeCount} edges [${elapsed}ms]`);
    } else if (graph.files.size > 0) {
      warn(
        `Module graph: ${graph.files.size} files but 0 edges`,
        "Files found but no internal imports resolved. Check tsconfig references."
      );
    } else {
      fail(
        "Module graph: 0 files discovered",
        "Check tsconfig.json includes source files and project root is correct"
      );
    }
  } catch (err) {
    fail(
      `Module graph build failed: ${err instanceof Error ? err.message : String(err)}`,
      "Check that oxc-parser and oxc-resolver are installed correctly"
    );
  }

  // 11. ESLint ignores (only when typegraph-mcp is embedded inside the project)
  if (toolIsEmbedded) {
    const eslintConfigPath = path.resolve(projectRoot, "eslint.config.mjs");
    if (fs.existsSync(eslintConfigPath)) {
      const eslintContent = fs.readFileSync(eslintConfigPath, "utf-8");
      const hasToolsIgnore = /["']tools\/\*\*["']/.test(eslintContent);
      const hasTestIgnore = /["']\.typegraph-test\/\*\*["']/.test(eslintContent);

      if (hasToolsIgnore && hasTestIgnore) {
        pass("ESLint ignores tools/ and .typegraph-test/");
      } else {
        const missing: string[] = [];
        if (!hasToolsIgnore) missing.push('"tools/**"');
        if (!hasTestIgnore) missing.push('".typegraph-test/**"');
        fail(
          `ESLint missing ignores: ${missing.join(", ")}`,
          `Add to the ignores array in eslint.config.mjs:\n` +
            missing.map((m) => `    ${m},`).join("\n")
        );
      }
    } else {
      skip("ESLint config check (no eslint.config.mjs)");
    }
  } else {
    skip("ESLint config check (typegraph-mcp is external to project)");
  }

  // 12. .gitignore check (optional)
  const gitignorePath = path.resolve(projectRoot, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
    const lines = gitignoreContent
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith("#"));
    const ignoresClaude = lines.some(
      (l: string) => l === ".claude/" || l === ".claude" || l === "/.claude"
    );

    // Only check tools/ exclusion when typegraph-mcp is embedded
    const ignoresTools =
      toolIsEmbedded &&
      lines.some((l: string) => l === "tools/" || l === "tools" || l === "/tools");

    if (!ignoresTools && !ignoresClaude) {
      pass(".gitignore does not exclude .claude/" + (toolIsEmbedded ? " or tools/" : ""));
    } else {
      const excluded: string[] = [];
      if (ignoresTools) excluded.push("tools/");
      if (ignoresClaude) excluded.push(".claude/");
      warn(
        `.gitignore excludes ${excluded.join(" and ")}`,
        "Remove these entries so MCP config and tool source are tracked in git"
      );
    }
  } else {
    skip(".gitignore check (no .gitignore)");
  }

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log("");
  const total = passed + failed;
  if (failed === 0) {
    console.log(
      `${passed}/${total} checks passed` +
        (warned > 0 ? ` (${warned} warning${warned > 1 ? "s" : ""})` : "") +
        " -- typegraph-mcp is ready"
    );
  } else {
    console.log(
      `${passed}/${total} checks passed, ${failed} failed` +
        (warned > 0 ? `, ${warned} warning${warned > 1 ? "s" : ""}` : "") +
        " -- fix issues above"
    );
  }
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Find first .ts file in the project (for resolver smoke test) */
function findFirstTsFile(dir: string): string | null {
  const skipDirs = new Set(["node_modules", "dist", ".git", ".wrangler", "coverage"]);
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        return path.join(dir, entry.name);
      }
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !skipDirs.has(entry.name) && !entry.name.startsWith(".")) {
        const found = findFirstTsFile(path.join(dir, entry.name));
        if (found) return found;
      }
    }
  } catch {
    // Permission error or similar
  }
  return null;
}

/** Spawn tsserver, send configure, verify response, shut down */
function testTsserver(): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 10000);

    let tsserverPath: string;
    try {
      const require = createRequire(path.resolve(projectRoot, "package.json"));
      tsserverPath = require.resolve("typescript/lib/tsserver.js");
    } catch {
      clearTimeout(timeout);
      resolve(false);
      return;
    }

    const child = spawn("node", [tsserverPath, "--disableAutomaticTypingAcquisition"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    child.stdout.on("data", (chunk: { toString(): string }) => {
      buffer += chunk.toString();
      // tsserver sends Content-Length framed JSON — look for success response
      if (buffer.includes('"success":true')) {
        clearTimeout(timeout);
        child.kill();
        resolve(true);
      }
    });

    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });

    child.on("exit", () => {
      clearTimeout(timeout);
      // If we haven't resolved yet, it failed
    });

    // Send configure request (newline-delimited JSON, not Content-Length framed)
    const request = JSON.stringify({
      seq: 1,
      type: "request",
      command: "configure",
      arguments: {
        preferences: { disableSuggestions: true },
      },
    });
    child.stdin.write(request + "\n");
  });
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
