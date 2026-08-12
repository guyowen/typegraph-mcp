/**
 * Per-provider MCP server registration.
 *
 * Each provider wants a different file, a different root key, and — the part
 * that broke the generic helper inherited from typegraph-mcp — a different
 * entry SHAPE. OpenCode collapses command+args into a single array, so the
 * old `rootKey === "servers"` special-case doesn't generalize. buildMcpEntry()
 * in agents.ts owns the shapes; this module owns the file I/O.
 *
 * Scope is the other axis. Project-scoped configs (.mcp.json, .cursor/mcp.json,
 * opencode.json, .codex/config.toml) live in the repo and normally get
 * committed, so they receive a project-relative server path — an absolute one
 * would resolve only on the machine that ran setup. Antigravity's config is in
 * $HOME and cannot use a relative path for either the server or the project
 * root, so it gets absolutes for both.
 */
import fs from "node:fs";
import path from "node:path";
import {
  AGENTS,
  AGENT_IDS,
  buildMcpEntry,
  type AgentId,
  type McpCommand,
  type McpScope,
} from "./agents.ts";
import { serverArgFor, type ServerTarget } from "./install-paths.ts";
import { readConfig } from "./jsonc.ts";

export const SERVER_KEY = "typegraph";

export interface RegisterResult {
  file: string;
  action: "written" | "skipped" | "unchanged";
  reason?: string;
}

/** OpenCode reads opencode.json OR opencode.jsonc — prefer whichever exists. */
function resolveConfigPath(projectRoot: string, file: string): string {
  const full = path.resolve(projectRoot, file);
  if (file === "opencode.json" && !fs.existsSync(full)) {
    const jsonc = path.resolve(projectRoot, "opencode.jsonc");
    if (fs.existsSync(jsonc)) return jsonc;
  }
  return full;
}

function writeJsonConfig(
  projectRoot: string,
  file: string,
  rootKey: string,
  entry: Record<string, unknown>,
): RegisterResult {
  const fullPath = resolveConfigPath(projectRoot, file);
  const config = readConfig(fs, fullPath);

  if (config === undefined) {
    return {
      file: fullPath,
      action: "skipped",
      reason: "could not parse existing config (even as JSONC) — left untouched",
    };
  }

  const servers = (config[rootKey] as Record<string, unknown>) ?? {};
  const before = JSON.stringify(servers[SERVER_KEY]);
  servers[SERVER_KEY] = entry;
  config[rootKey] = servers;

  if (before === JSON.stringify(entry)) {
    return { file: fullPath, action: "unchanged" };
  }

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  // Writing plain JSON even to a .jsonc path is intentional and lossless for
  // data — but it DOES drop the user's comments, so say so at the call site.
  fs.writeFileSync(fullPath, JSON.stringify(config, null, 2) + "\n");
  return {
    file: fullPath,
    action: "written",
    ...(fullPath.endsWith(".jsonc") ? { reason: "comments in opencode.jsonc were not preserved" } : {}),
  };
}

const CODEX_BEGIN = "# >>> typegraph-mcp >>>";
const CODEX_END = "# <<< typegraph-mcp <<<";
const LEGACY_CODEX_BEGIN = "# >>> typegraph-go >>>";
const LEGACY_CODEX_END = "# <<< typegraph-go <<<";

function findCodexBlock(content: string): { begin: number; end: number; endMarker: string } | undefined {
  for (const [beginMarker, endMarker] of [
    [CODEX_BEGIN, CODEX_END],
    [LEGACY_CODEX_BEGIN, LEGACY_CODEX_END],
  ] as const) {
    const begin = content.indexOf(beginMarker);
    const end = content.indexOf(endMarker);
    if (begin !== -1 && end !== -1 && end > begin) return { begin, end, endMarker };
  }
  return undefined;
}

/** `typegraph`, `"typegraph"`, or `'typegraph'` — TOML allows all three. */
const KEY_FORMS = String.raw`(?:${SERVER_KEY}|"${SERVER_KEY}"|'${SERVER_KEY}')`;
const BARE_TABLE_RE = new RegExp(
  String.raw`^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*${KEY_FORMS}[ \t]*\][ \t]*$`,
  "m",
);
const NEXT_HEADER_RE = /^[ \t]*\[/m;

/**
 * A `[mcp_servers.typegraph]` table this installer didn't write — hand-rolled,
 * or left by a version that predates the sentinels.
 *
 * It carries no markers, so the sentinel scan misses it and we would append a
 * SECOND table with the same key. That doesn't merely leave a stale entry: TOML
 * rejects duplicate keys outright, so the agent fails to parse its config at all
 * and stops launching. Overwrite the bare table in place instead.
 *
 * The span stops at the next table header, which preserves any
 * `[mcp_servers.typegraph.tools.*]` subtables — those are distinct keys, and
 * TOML permits a super-table to be defined ahead of them.
 */
function findBareTypegraphTable(content: string): { begin: number; end: number } | undefined {
  const header = BARE_TABLE_RE.exec(content);
  if (!header) return undefined;
  const bodyStart = header.index + header[0].length;
  const nextHeader = NEXT_HEADER_RE.exec(content.slice(bodyStart));
  return {
    begin: header.index,
    end: nextHeader ? bodyStart + nextHeader.index : content.length,
  };
}

/**
 * `[mcp_servers]` carrying an inline `typegraph = { ... }` key collides exactly
 * the same way, but can't be rewritten by span — the enclosing table isn't ours
 * to replace. Bail loudly rather than emit a file the agent refuses to parse.
 */
function hasInlineTypegraphKey(content: string): boolean {
  const section = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\][ \t]*$/m.exec(content);
  if (!section) return false;
  const bodyStart = section.index + section[0].length;
  const rest = content.slice(bodyStart);
  const nextHeader = NEXT_HEADER_RE.exec(rest);
  const body = nextHeader ? rest.slice(0, nextHeader.index) : rest;
  return new RegExp(String.raw`^[ \t]*${KEY_FORMS}[ \t]*[.=]`, "m").test(body);
}

function writeCodexToml(projectRoot: string, cmd: McpCommand): RegisterResult {
  const fullPath = path.resolve(projectRoot, ".codex/config.toml");
  const argsToml = cmd.args.map((a) => JSON.stringify(a)).join(", ");
  const block = [
    CODEX_BEGIN,
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${JSON.stringify(cmd.command)}`,
    `args = [${argsToml}]`,
    ...(cmd.env
      ? [`env = { ${Object.entries(cmd.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")} }`]
      : []),
    CODEX_END,
  ].join("\n");

  let content = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf-8") : "";
  const existing = findCodexBlock(content);

  let next: string;
  if (existing) {
    next = content.slice(0, existing.begin) + block + content.slice(existing.end + existing.endMarker.length);
  } else {
    const bare = findBareTypegraphTable(content);
    if (bare) {
      const tail = content.slice(bare.end);
      next = content.slice(0, bare.begin) + block + (tail.trim() ? `\n\n${tail}` : "\n");
    } else if (hasInlineTypegraphKey(content)) {
      return {
        file: fullPath,
        action: "skipped",
        reason: `an inline "${SERVER_KEY}" key under [mcp_servers] would become a duplicate TOML key — remove it, then re-run setup`,
      };
    } else {
      next = content.trimEnd() + (content.trim() ? "\n\n" : "") + block + "\n";
    }
  }

  if (next === content) return { file: fullPath, action: "unchanged" };
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, next);
  return { file: fullPath, action: "written" };
}



export interface RegisterOptions {
  interpreter: string;
  target: ServerTarget;
  tsconfig?: string;
}

/**
 * The server invocation for a config of the given scope.
 *
 * TYPEGRAPH_PROJECT_ROOT is "." for project-scoped configs — the agent launches
 * the server with the project as cwd — and absolute for global ones, where cwd
 * is whatever workspace the user happens to have open.
 */
function commandFor(
  projectRoot: string,
  scope: McpScope,
  options: RegisterOptions,
): McpCommand {
  return {
    command: options.interpreter,
    args: [serverArgFor(options.target, scope)],
    env: {
      TYPEGRAPH_PROJECT_ROOT: scope === "project" ? "." : projectRoot,
      TYPEGRAPH_TSCONFIG: options.tsconfig ?? "./tsconfig.json",
    },
  };
}

export function registerMcp(
  projectRoot: string,
  selectedAgents: readonly AgentId[],
  options: RegisterOptions,
): RegisterResult[] {
  const results: RegisterResult[] = [];
  const seen = new Set<string>();

  for (const id of selectedAgents) {
    const reg = AGENTS[id].mcp;
    if (reg.kind === "none") continue;

    const cmd = commandFor(projectRoot, reg.scope, options);
    switch (reg.kind) {
      case "json": {
        // Claude Code and Cursor can both land on the same file in principle;
        // writing it twice is harmless but would double the log lines.
        if (seen.has(reg.file)) break;
        seen.add(reg.file);
        results.push(
          writeJsonConfig(projectRoot, reg.file, reg.rootKey, buildMcpEntry(reg.shape, cmd)),
        );
        break;
      }
      case "codex-toml":
        results.push(writeCodexToml(projectRoot, cmd));
        break;
    }
  }
  return results;
}

export function deregisterMcp(projectRoot: string): string[] {
  const removed: string[] = [];

  for (const id of AGENT_IDS) {
    const reg = AGENTS[id].mcp;
    if (reg.kind !== "json") continue;
    const fullPath = resolveConfigPath(projectRoot, reg.file);
    if (!fs.existsSync(fullPath)) continue;
    const config = readConfig(fs, fullPath);
    if (!config) continue;
    const servers = config[reg.rootKey] as Record<string, unknown> | undefined;
    if (!servers?.[SERVER_KEY]) continue;
    delete servers[SERVER_KEY];
    fs.writeFileSync(fullPath, JSON.stringify(config, null, 2) + "\n");
    removed.push(fullPath);
  }

  const codex = path.resolve(projectRoot, ".codex/config.toml");
  if (fs.existsSync(codex)) {
    let content = fs.readFileSync(codex, "utf-8");
    let removedCodex = false;
    for (;;) {
      const block = findCodexBlock(content);
      if (!block) break;
      content = content.slice(0, block.begin) + content.slice(block.end + block.endMarker.length);
      removedCodex = true;
    }
    if (removedCodex) {
      fs.writeFileSync(codex, content.trimEnd() + "\n");
      removed.push(codex);
    }
  }

  return removed;
}
