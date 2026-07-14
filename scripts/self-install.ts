#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const SELF_INSTALL_IGNORES = [
  "/plugins/typegraph-mcp/",
  "/.agents/",
  "/.codex/",
  "/AGENTS.md",
  "/CLAUDE.md",
] as const;

export function isGitWorkTree(projectRoot: string): boolean {
  const result = spawnSync("git", ["-C", projectRoot, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

export function ensureSelfInstallIgnores(projectRoot: string): string[] {
  if (!isGitWorkTree(projectRoot)) return [];

  const gitignorePath = path.join(projectRoot, ".gitignore");
  const existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, "utf-8")
    : "";
  const existingLines = new Set(existing.split(/\r?\n/));
  const added = SELF_INSTALL_IGNORES.filter((pattern) => !existingLines.has(pattern));

  if (added.length > 0) {
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(gitignorePath, `${existing}${separator}${added.join("\n")}\n`);
  }

  return [...added];
}

function ensureAgentMarkers(projectRoot: string): void {
  for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = path.join(projectRoot, fileName);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "");
  }
}

function main(): void {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const addedIgnores = ensureSelfInstallIgnores(projectRoot);

  if (isGitWorkTree(projectRoot)) {
    console.log(
      addedIgnores.length > 0
        ? `Added ${addedIgnores.length} self-install entries to .gitignore`
        : "Self-install artifacts are already ignored"
    );
  } else {
    console.log("Git worktree not found; skipping .gitignore update");
  }

  ensureAgentMarkers(projectRoot);

  const tsxPath = path.join(projectRoot, "node_modules/.bin/tsx");
  const cliPath = path.join(projectRoot, "cli.ts");
  const result = spawnSync(tsxPath, [cliPath, "setup", "--yes"], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
