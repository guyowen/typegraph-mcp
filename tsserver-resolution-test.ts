#!/usr/bin/env npx tsx

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveTsServer } from "./tsserver-client.js";

function createProject(root: string, name: string): string {
  const projectRoot = path.join(root, name);
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify({ name, private: true }, null, 2)}\n`
  );
  return projectRoot;
}

const repoRoot = import.meta.dirname;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typegraph-tsserver-resolution-"));

try {
  const ts7Project = createProject(tempRoot, "ts7-project");
  const ts7PackageRoot = path.join(ts7Project, "node_modules/typescript");
  fs.mkdirSync(ts7PackageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(ts7PackageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "typescript",
        version: "7.0.2",
        exports: { "./package.json": "./package.json", ".": "./lib/version.cjs" },
      },
      null,
      2
    )}\n`
  );
  fs.mkdirSync(path.join(ts7PackageRoot, "lib"), { recursive: true });
  fs.writeFileSync(path.join(ts7PackageRoot, "lib/version.cjs"), "module.exports = {};\n");

  const ts7Resolution = resolveTsServer(ts7Project);
  assert.equal(ts7Resolution.source, "typegraph");
  assert.equal(ts7Resolution.projectVersion, "7.0.2");
  assert.match(ts7Resolution.version, /^5\./);
  assert.ok(fs.existsSync(ts7Resolution.path));

  const ts5Project = createProject(tempRoot, "ts5-project");
  fs.mkdirSync(path.join(ts5Project, "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "node_modules/typescript"),
    path.join(ts5Project, "node_modules/typescript"),
    "dir"
  );

  const ts5Resolution = resolveTsServer(ts5Project);
  assert.equal(ts5Resolution.source, "project");
  assert.match(ts5Resolution.version, /^5\./);
  assert.equal(ts5Resolution.projectVersion, undefined);

  console.log("");
  console.log("typegraph-mcp Tsserver Resolution Test");
  console.log("======================================");
  console.log("  ✓ TypeScript 7 projects use TypeGraph's compatible tsserver runtime");
  console.log("  ✓ TypeScript 5 projects keep using their own tsserver runtime");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
