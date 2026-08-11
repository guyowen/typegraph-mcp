#!/usr/bin/env node
/**
 * typegraph-mcp check — health check.
 *
 * Exists largely because the interesting failure modes are SILENT: a
 * version-skewed API client (msgpack decode errors deep in a request), a baked
 * interpreter path pointing at an uninstalled Node version, and — since the
 * plugin directory went away — a server path pointing at a package that was
 * moved, uninstalled, or garbage-collected out of the npx cache. In all three
 * cases the MCP server simply never produces results, so each is checked here.
 */
import fs from "node:fs";
import path from "node:path";
import { projectJsonMcpConfigs } from "./agents.ts";
import { inspectVersions } from "./version-guard.ts";
import { ApiClient, resolveExePath } from "./api-client.ts";
import { resolveConfig } from "./config.ts";
import { buildGraph } from "./module-graph.ts";
import {
  MIN_NODE_VERSION,
  nodeVersion,
  resolveInterpreter,
  supportsNativeTypeScript,
} from "./install-paths.ts";
import { SERVER_KEY } from "./mcp-register.ts";
import { readConfig } from "./jsonc.ts";

interface Finding {
  level: "ok" | "warn" | "fail";
  label: string;
  detail: string;
}

const findings: Finding[] = [];
const add = (level: Finding["level"], label: string, detail: string): void => {
  findings.push({ level, label, detail });
};

interface InstalledEntry {
  where: string;
  /** Directory relative paths in this entry resolve against. */
  base: string;
  command: string;
  serverArg: string | undefined;
}

function fromJsonConfig(
  fullPath: string,
  base: string,
  rootKey: string,
  entries: InstalledEntry[],
): void {
  if (!fs.existsSync(fullPath)) return;
  const cfg = readConfig(fs, fullPath);
  if (!cfg) {
    add("warn", path.basename(fullPath), `unparseable: ${fullPath}`);
    return;
  }
  const entry = (cfg[rootKey] as Record<string, any> | undefined)?.[SERVER_KEY];
  if (!entry) return;
  // OpenCode collapses command+args into one array; everyone else splits them.
  const [command, serverArg] = Array.isArray(entry.command)
    ? [entry.command[0], entry.command[1]]
    : [entry.command, entry.args?.[0]];
  if (typeof command === "string") {
    entries.push({ where: fullPath, base, command, serverArg });
  }
}

function collectInstalled(projectRoot: string): InstalledEntry[] {
  const entries: InstalledEntry[] = [];

  for (const { file, rootKey } of projectJsonMcpConfigs()) {
    fromJsonConfig(path.resolve(projectRoot, file), projectRoot, rootKey, entries);
    if (file === "opencode.json") {
      fromJsonConfig(path.resolve(projectRoot, "opencode.jsonc"), projectRoot, rootKey, entries);
    }
  }

  const codex = path.resolve(projectRoot, ".codex/config.toml");
  if (fs.existsSync(codex)) {
    const block = /\[mcp_servers\.typegraph\]([\s\S]*?)(?=\n\[|$)/.exec(
      fs.readFileSync(codex, "utf-8"),
    )?.[1];
    if (block) {
      const command = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(block)?.[1];
      const serverArg = /^\s*args\s*=\s*\[\s*"((?:[^"\\]|\\.)*)"/m.exec(block)?.[1];
      if (command) entries.push({ where: codex, base: projectRoot, command, serverArg });
    }
  }

  const antigravity = path.join(process.env["HOME"] ?? "", ".gemini/antigravity/mcp_config.json");
  fromJsonConfig(antigravity, path.dirname(antigravity), "mcpServers", entries);

  return entries;
}

function checkInstalled(projectRoot: string): void {
  const entries = collectInstalled(projectRoot);
  if (entries.length === 0) {
    add("warn", "installed configs", "no MCP registration found — run `typegraph-mcp setup`");
    return;
  }

  for (const { where, base, command, serverArg } of entries) {
    const label = path.relative(projectRoot, where) || path.basename(where);

    const version = nodeVersion(command);
    if (version && supportsNativeTypeScript(version)) {
      add(
        "ok",
        "interpreter",
        command.includes("/")
          ? `${label}: ${command} (Node ${version})`
          : `${label}: "${command}" (PATH-resolved Node ${version})`,
      );
    } else if (version) {
      add(
        "fail",
        "interpreter TOO OLD",
        `${where}\n    -> ${command} resolved to Node ${version}; typegraph-mcp requires >=${MIN_NODE_VERSION}. Re-run setup from a newer Node runtime.`,
      );
    } else if (!command.includes("/")) {
      add(
        "fail",
        "interpreter MISSING",
        `${where}\n    -> ${command}\n    This command is not on PATH. Re-run \`typegraph-mcp setup\` after configuring Node >=${MIN_NODE_VERSION}.`,
      );
    } else {
      add(
        "fail",
        "interpreter MISSING",
        `${where}\n    -> ${command}\n    This MCP server cannot start. Re-run \`typegraph-mcp setup\` to repair.`,
      );
    }

    if (!serverArg) {
      add("warn", "server path", `${label}: entry has no script argument`);
      continue;
    }
    const resolved = path.resolve(base, serverArg);
    if (fs.existsSync(resolved)) {
      add("ok", "server path", `${label}: ${serverArg}`);
    } else {
      add(
        "fail",
        "server MISSING",
        `${where}\n    -> ${resolved}\n    The package it points at is gone. Re-run \`typegraph-mcp setup\` to repair.`,
      );
    }
  }
}

async function main(): Promise<void> {
  const config = resolveConfig(import.meta.dirname);
  const { projectRoot, tsconfigPath, excludedPaths } = config;
  const tsconfigAbs = path.resolve(projectRoot, tsconfigPath);

  console.log(`typegraph-mcp check\n  project: ${projectRoot}\n`);

  // 1. Executable resolution
  try {
    const exe = await resolveExePath(projectRoot);
    if (fs.existsSync(exe.path)) {
      add("ok", "tsgo binary", `${exe.path}\n    via ${exe.source}`);
    } else {
      add("fail", "tsgo binary", `resolved but missing: ${exe.path}`);
    }
  } catch (err) {
    add("fail", "tsgo binary", err instanceof Error ? err.message : String(err));
  }

  // 2. Version skew — silent failure mode, no protocol handshake exists
  const v = inspectVersions();
  if (v.agrees) {
    add(
      "ok",
      "api version",
      `typescript ${v.clientVersion}` +
        (v.channel ? ` matches @effect/tsgo ${v.effectTsgoVersion ?? "?"} channel "${v.channel}"` : "") +
        (v.binaryGitHead ? `\n    tsgo commit ${v.binaryGitHead.slice(0, 12)}` : ""),
    );
  } else {
    add(
      "fail",
      "api version SKEW",
      `client typescript ${v.clientVersion} != binary pin ${v.binaryPinnedVersion ?? "unknown"}\n` +
        `    The --api protocol has no version handshake; this surfaces as msgpack\n` +
        `    decode errors mid-request. Install typescript@${v.binaryPinnedVersion ?? "<pin>"}.`,
    );
  }

  // 3. Interpreter policy, then what is actually on disk
  const interp = resolveInterpreter();
  add(
    interp.stable ? "ok" : "warn",
    "interpreter policy",
    `${interp.command}${interp.note ? `\n    ${interp.note}` : ""}`,
  );
  checkInstalled(projectRoot);

  // 4. Target project shape
  const tsconfigExists = fs.existsSync(tsconfigAbs);
  if (tsconfigExists) {
    add(
      "ok",
      "tsconfig",
      `${path.relative(projectRoot, tsconfigAbs) || path.basename(tsconfigAbs)} exists`,
    );
  } else {
    add(
      "fail",
      "tsconfig MISSING",
      `${tsconfigAbs}\n    TSGo semantic tools open an explicit tsconfig project; add tsconfig.json or set TYPEGRAPH_TSCONFIG to the intended config.`,
    );
  }

  // 5. Module graph smoke: exercises oxc-parser + oxc-resolver against the target.
  try {
    const start = performance.now();
    const { graph } = await buildGraph(projectRoot, tsconfigPath, excludedPaths);
    const elapsed = (performance.now() - start).toFixed(0);
    const edgeCount = [...graph.forward.values()].reduce((sum, edges) => sum + edges.length, 0);
    if (graph.files.size === 0) {
      add(
        "fail",
        "module graph",
        "0 TypeScript source files discovered. Check project root, tsconfig, and ignored directories.",
      );
    } else if (edgeCount === 0) {
      add(
        "warn",
        "module graph",
        `${graph.files.size} files, 0 edges [${elapsed}ms]\n    Files were found but no project imports resolved. Check tsconfig paths/references if this looks wrong.`,
      );
    } else {
      add("ok", "module graph", `${graph.files.size} files, ${edgeCount} edges [${elapsed}ms]`);
    }
  } catch (err) {
    add(
      "fail",
      "module graph",
      `${err instanceof Error ? err.message : String(err)}\n    Check that oxc-parser/oxc-resolver are installed and TYPEGRAPH_TSCONFIG points at a valid config.`,
    );
  }

  // 6. Semantic project smoke: proves the TSGo API opens the configured project.
  if (tsconfigExists) {
    let client: ApiClient | undefined;
    try {
      client = await ApiClient.create({ projectRoot, tsconfig: tsconfigAbs });
      const files = (await client.projectFiles()).length;
      if (files > 0) {
        add("ok", "semantic project", `${files} files opened from ${tsconfigPath}`);
      } else {
        add(
          "fail",
          "semantic project",
          `TSGo opened ${tsconfigPath}, but it contains 0 source files. Check include/files/references.`,
        );
      }
    } catch (err) {
      add(
        "fail",
        "semantic project",
        `${err instanceof Error ? err.message : String(err)}\n    Verify ${tsconfigPath} is valid and the TypeScript 7 runtime packaged with typegraph-mcp is installed.`,
      );
    } finally {
      await client?.close().catch(() => {});
    }
  }

  // Report
  const icon = { ok: "  ok  ", warn: " warn ", fail: " FAIL " } as const;
  for (const f of findings) {
    console.log(`[${icon[f.level]}] ${f.label}\n    ${f.detail}`);
  }

  const failed = findings.filter((f) => f.level === "fail").length;
  const warned = findings.filter((f) => f.level === "warn").length;
  console.log(`\n${findings.length} checks — ${failed} failed, ${warned} warnings`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
