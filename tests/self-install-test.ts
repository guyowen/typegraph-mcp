#!/usr/bin/env npx tsx

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SELF_INSTALL_IGNORES,
  ensureSelfInstallIgnores,
} from "../scripts/self-install.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typegraph-self-install-"));

try {
  const gitProject = path.join(tempRoot, "git-project");
  fs.mkdirSync(gitProject);
  execFileSync("git", ["init", "--quiet"], { cwd: gitProject });
  fs.writeFileSync(path.join(gitProject, ".gitignore"), "dist/\n");

  assert.deepEqual(ensureSelfInstallIgnores(gitProject), [...SELF_INSTALL_IGNORES]);
  const firstUpdate = fs.readFileSync(path.join(gitProject, ".gitignore"), "utf-8");
  assert.deepEqual(ensureSelfInstallIgnores(gitProject), []);
  assert.equal(fs.readFileSync(path.join(gitProject, ".gitignore"), "utf-8"), firstUpdate);

  for (const pattern of SELF_INSTALL_IGNORES) {
    assert.equal(firstUpdate.split("\n").filter((line) => line === pattern).length, 1);
  }

  const nonGitProject = path.join(tempRoot, "non-git-project");
  fs.mkdirSync(nonGitProject);
  assert.deepEqual(ensureSelfInstallIgnores(nonGitProject), []);
  assert.equal(fs.existsSync(path.join(nonGitProject, ".gitignore")), false);

  console.log("");
  console.log("typegraph-mcp Self-install Test");
  console.log("===============================");
  console.log("  ✓ Git worktrees receive every self-install ignore exactly once");
  console.log("  ✓ non-Git directories are left unchanged");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
