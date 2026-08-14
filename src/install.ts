/**
 * The `setup` and `remove` commands.
 *
 * Split out of cli.ts so that the CLI entry point can dispatch to the MCP
 * server without loading any of this — @clack/prompts writes to stdout, and
 * stdout belongs exclusively to JSON-RPC once a client is on the other end.
 *
 * Setup writes SKILL.md files and MCP config entries. It does not copy this
 * package anywhere: the config points at wherever the package is already
 * installed, so there is no second copy to keep in sync and no separate
 * dependency install to fail.
 */
import * as p from "@clack/prompts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS, AGENT_IDS, type AgentId } from "./agents.ts";
import {
  installSkills,
  LEGACY_PLACEHOLDERS,
  removeSkills,
  SKILL_NAMES,
  skillsDirFor,
} from "./install-skills.ts";
import { resolveServerTarget } from "./install-paths.ts";
import { deregisterMcp, registerMcp } from "./mcp-register.ts";

const SNIPPET_MARKER = "## TypeScript Navigation (typegraph-mcp)";

/** Left behind by older plugin installs, which copied the package into the project. */
const LEGACY_PLUGIN_DIR = "plugins/typegraph-mcp";

const AGENT_SNIPPET = `
${SNIPPET_MARKER}

Use the \`ts_*\` MCP tools before \`rg\`/\`grep\` for TypeScript navigation and Effect-aware editor feedback. They resolve through barrel files, re-exports, and project references; return semantic results instead of string matches; and expose TSGo LSP hover, diagnostics, and code actions when available.

- Point queries: \`ts_find_symbol\`, \`ts_definition\`, \`ts_references\`, \`ts_type_info\`, \`ts_navigate_to\`, \`ts_trace_chain\`, \`ts_blast_radius\`, \`ts_module_exports\`
- TSGo LSP tools: \`ts_hover\`, \`ts_layer_hover\`, \`ts_effect_diagnostics\`, \`ts_code_actions\`
- Graph queries: \`ts_dependency_tree\`, \`ts_dependents\`, \`ts_import_cycles\`, \`ts_shortest_path\`, \`ts_subgraph\`, \`ts_module_boundary\`
- Agent helpers: \`ts_project_info\`, \`ts_document_symbols\`, \`ts_symbol_overview\`, \`ts_dead_exports\`

\`ts_navigate_to\` searches exported symbols by default and returns exact counts. Pass \`includeLocals\` to also reach non-exported locals and class members — that half is capped at 256 and sets \`localsTruncated\`; never compare counts from a truncated result. Pass \`file\` to also search one file's document symbols, the only way to find object-literal keys such as RPC handler maps. \`maxResults\` (default 10) trims the returned list only — the counts always describe the full result set.

Use \`ts_project_info\` once at the start of a session to confirm the project root, tsconfig, backend, and graph/index sizes. Use \`ts_document_symbols\` for route tables, RPC handler maps, and object-literal keys in a known file. Use \`ts_symbol_overview\` as the first pass for change-risk questions. Use \`ts_hover\` when editor hover presentation matters; on Effect projects it can include expanded Success/Failure/Requirements blocks. Use \`ts_layer_hover\` for Effect Layer graph hover content. Use \`ts_effect_diagnostics\` for Effect LSP rule feedback and \`ts_code_actions\` for available quick fixes/refactors. If \`ts_effect_diagnostics\` returns \`unavailable: true\`, the current project is using the plain TypeScript TSGo fallback rather than \`@effect/tsgo\`; continue with non-Effect semantic tools. Use \`ts_dead_exports\` for explicit dead-export audits.

Start with TypeGraph MCP before reading entire files or grepping TypeScript. Use \`rg\`/\`grep\` for non-TypeScript assets, docs, config, and broad syntactic discovery when there is no symbol/type/navigation question.
`.trimStart();

function detectAgents(projectRoot: string): AgentId[] {
  return AGENT_IDS.filter((id) => AGENTS[id].detect(projectRoot));
}

async function selectAgents(projectRoot: string, yes: boolean): Promise<AgentId[]> {
  const detected = detectAgents(projectRoot);
  if (yes) return detected.length > 0 ? detected : ["claude-code"];

  const selected = await p.multiselect({
    message: "Which agents should typegraph-mcp be installed for?",
    options: AGENT_IDS.map((id) => ({
      value: id,
      label: AGENTS[id].name,
      hint: detected.includes(id) ? "detected" : undefined,
    })),
    initialValues: detected.length > 0 ? detected : (["claude-code"] as AgentId[]),
    required: true,
  });
  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return selected as AgentId[];
}

function updateAgentFile(projectRoot: string, relPath: string): "added" | "present" | "created" {
  const full = path.resolve(projectRoot, relPath);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, AGENT_SNIPPET);
    return "created";
  }
  const content = fs.readFileSync(full, "utf-8");
  if (content.includes(SNIPPET_MARKER)) return "present";
  fs.writeFileSync(full, content.trimEnd() + "\n\n" + AGENT_SNIPPET);
  return "added";
}

function removeAgentSnippet(projectRoot: string, relPath: string): boolean {
  const full = path.resolve(projectRoot, relPath);
  if (!fs.existsSync(full)) return false;
  const content = fs.readFileSync(full, "utf-8");
  const at = content.indexOf(SNIPPET_MARKER);
  if (at === -1) return false;
  // The snippet runs to the next top-level heading or EOF.
  const rest = content.slice(at + SNIPPET_MARKER.length);
  const nextHeading = rest.search(/\n## /);
  const end = nextHeading === -1 ? content.length : at + SNIPPET_MARKER.length + nextHeading + 1;
  fs.writeFileSync(full, (content.slice(0, at) + content.slice(end)).trimEnd() + "\n");
  return true;
}

function pathEqualsOrContains(candidatePath: string, targetPath: string): boolean {
  const comparable = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const resolvedCandidate = comparable(candidatePath);
  const resolvedTarget = comparable(targetPath);
  if (resolvedCandidate === resolvedTarget || resolvedCandidate.startsWith(resolvedTarget + path.sep)) {
    return true;
  }

  try {
    const realCandidate = comparable(fs.realpathSync(candidatePath));
    const realTarget = comparable(fs.realpathSync(targetPath));
    return realCandidate === realTarget || realCandidate.startsWith(realTarget + path.sep);
  } catch {
    return false;
  }
}

function isTomlSectionGroup(sectionName: string | null, prefix: string): boolean {
  return sectionName === prefix || sectionName?.startsWith(`${prefix}.`) === true;
}

function splitTomlBlocks(content: string): Array<{ sectionName: string | null; raw: string }> {
  const blocks: Array<{ sectionName: string | null; raw: string }> = [];
  let sectionName: string | null = null;
  let lines: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]\s*$/.exec(line);
    if (match) {
      if (lines.length > 0 || sectionName !== null) {
        blocks.push({ sectionName, raw: lines.join("\n") });
      }
      sectionName = match[1]!;
      lines = [line];
      continue;
    }
    lines.push(line);
  }

  if (lines.length > 0 || sectionName !== null) blocks.push({ sectionName, raw: lines.join("\n") });
  return blocks;
}

function removeTomlSectionGroup(
  content: string,
  prefix: string,
): { content: string; removed: boolean; removedContent: string } {
  const blocks = splitTomlBlocks(content);
  const removedBlocks = blocks.filter((block) => isTomlSectionGroup(block.sectionName, prefix));
  if (removedBlocks.length === 0) return { content, removed: false, removedContent: "" };

  const next = blocks
    .filter((block) => !isTomlSectionGroup(block.sectionName, prefix))
    .map((block) => block.raw)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  return {
    content: next ? `${next}\n` : "",
    removed: true,
    removedContent: removedBlocks.map((block) => block.raw).join("\n").trim(),
  };
}

function removeLegacyPluginArg(projectRoot: string): boolean {
  const claudeMd = path.resolve(projectRoot, "CLAUDE.md");
  if (!fs.existsSync(claudeMd)) return false;

  const content = fs.readFileSync(claudeMd, "utf-8");
  const next = content
    .replace(
      /\s+--plugin-dir\s+(?:"(?:\.\/)?plugins\/typegraph-mcp"|'(?:\.\/)?plugins\/typegraph-mcp'|(?:\.\/)?plugins\/typegraph-mcp)\b/g,
      "",
    )
    .replace(/[ \t]+\n/g, "\n");

  if (next === content) return false;
  fs.writeFileSync(claudeMd, next);
  return true;
}

function removeLegacyClaudeMcp(projectRoot: string): boolean {
  const mcpJson = path.resolve(projectRoot, ".claude/mcp.json");
  if (!fs.existsSync(mcpJson)) return false;

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(mcpJson, "utf-8"));
  } catch {
    return false;
  }

  if (!config?.mcpServers?.typegraph) return false;
  delete config.mcpServers.typegraph;
  fs.writeFileSync(mcpJson, JSON.stringify(config, null, 2) + "\n");
  return true;
}

function removeLegacyGlobalCodex(projectRoot: string): boolean {
  const home = os.homedir();
  const globalConfig = path.join(home, ".codex/config.toml");
  if (!fs.existsSync(globalConfig)) return false;

  const content = fs.readFileSync(globalConfig, "utf-8");
  const removed = removeTomlSectionGroup(content, "mcp_servers.typegraph");
  if (!removed.removed) return false;

  const pluginRoot = path.resolve(projectRoot, LEGACY_PLUGIN_DIR);
  const quotedPaths = Array.from(removed.removedContent.matchAll(/"([^"\n]+)"/g), (match) => match[1]!);
  const pointsAtProject = quotedPaths.some(
    (quotedPath) =>
      pathEqualsOrContains(quotedPath, projectRoot) || pathEqualsOrContains(quotedPath, pluginRoot),
  );
  if (!pointsAtProject) return false;

  if (removed.content === "") fs.unlinkSync(globalConfig);
  else fs.writeFileSync(globalConfig, removed.content);
  return true;
}

function hasLegacySkillPlaceholders(projectRoot: string): boolean {
  for (const target of ["claude", "agents", "cursor"] as const) {
    const root = skillsDirFor(projectRoot, target);
    for (const skill of SKILL_NAMES) {
      const file = path.join(root, skill, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf-8");
      if (LEGACY_PLACEHOLDERS.some((placeholder) => content.includes(placeholder))) return true;
    }
  }
  return false;
}

function cleanupLegacyPluginInstall(projectRoot: string, sourceDir: string): string[] {
  const cleaned: string[] = [];

  if (hasLegacySkillPlaceholders(projectRoot)) {
    const removed = removeSkills(projectRoot);
    if (removed > 0) cleaned.push(`removed ${removed} legacy skill directories`);
  }

  if (removeLegacyPluginArg(projectRoot)) cleaned.push("removed legacy Claude --plugin-dir entry");
  if (removeLegacyClaudeMcp(projectRoot)) cleaned.push("removed legacy .claude/mcp.json entry");
  if (removeLegacyGlobalCodex(projectRoot)) cleaned.push("removed stale global Codex MCP entry");

  const legacy = path.resolve(projectRoot, LEGACY_PLUGIN_DIR);
  if (
    fs.existsSync(path.join(legacy, "src/server.ts")) &&
    !pathEqualsOrContains(sourceDir, legacy)
  ) {
    fs.rmSync(legacy, { recursive: true, force: true });
    const plugins = path.dirname(legacy);
    if (fs.existsSync(plugins) && fs.readdirSync(plugins).length === 0) fs.rmdirSync(plugins);
    cleaned.push(`${LEGACY_PLUGIN_DIR}/ removed`);
  }

  return cleaned;
}

export async function setup(projectRoot: string, sourceDir: string, yes: boolean): Promise<void> {
  const configuredTsconfig = process.env["TYPEGRAPH_TSCONFIG"] || "./tsconfig.json";
  const tsconfigAbs = path.resolve(projectRoot, configuredTsconfig);
  const relativeTsconfig = path.relative(projectRoot, tsconfigAbs);
  const outsideProject = relativeTsconfig === ".." || relativeTsconfig.startsWith(`..${path.sep}`);
  if (
    path.isAbsolute(relativeTsconfig) ||
    (path.isAbsolute(configuredTsconfig) && (relativeTsconfig === "" || outsideProject))
  ) {
    throw new Error(
      `An absolute setup tsconfig must be inside the project root so generated configs remain portable: ${configuredTsconfig}`,
    );
  }
  const portableTsconfig = relativeTsconfig.replaceAll("\\", "/");
  const tsconfig = outsideProject ? portableTsconfig : `./${portableTsconfig}`;

  p.intro("typegraph-mcp setup");

  const selected = await selectAgents(projectRoot, yes);

  const legacyCleanup = cleanupLegacyPluginInstall(projectRoot, sourceDir);
  for (const item of legacyCleanup) p.log.success(`Legacy plugin cleanup: ${item}`);

  // 1. Where does the server actually live? Everything else is templated from this.
  const target = resolveServerTarget(projectRoot, sourceDir);
  const rel = target.relative ?? target.absolute;
  p.log.info(`Server: ${rel}${target.relative ? "" : "  (absolute — not a project dependency)"}`);
  if (target.note) p.log.warn(target.note);

  if (!fs.existsSync(tsconfigAbs)) {
    p.log.warn(
      `No tsconfig found at ${tsconfig}. TSGo semantic tools require an explicit tsconfig; ` +
        "create one or rerun setup with TYPEGRAPH_TSCONFIG pointing at the intended config.",
    );
  }

  // 2. Skills — routed to the minimal covering set of directories
  const skills = installSkills({
    sourceDir,
    projectRoot,
    packageRoot: target.packageRoot,
    tsconfig,
    selectedAgents: selected,
  });
  for (const [name, info] of Object.entries(skills.byTarget)) {
    const dir = path.relative(projectRoot, info.dir) || info.dir;
    p.log.success(`${dir}/ — ${info.written} skills for ${info.agents.join(", ")} (${name})`);
  }
  if (skills.unchanged > 0) p.log.info(`${skills.unchanged} skills already up to date`);

  // 3. MCP registration
  // No tsx at runtime. Source checkouts use the src/*.cjs trampolines to import
  // .ts directly after a Node-version guard; published packages use the same
  // trampolines from dist/ and import compiled .js because Node refuses native
  // type stripping for .ts files under node_modules.
  const results = registerMcp(projectRoot, selected, {
    target,
    tsconfig,
  });
  for (const r of results) {
    const file = path.relative(projectRoot, r.file) || r.file;
    if (r.action === "skipped") p.log.warn(`${file}: skipped — ${r.reason}`);
    else if (r.action === "written") p.log.success(`${file}: registered${r.reason ? ` (${r.reason})` : ""}`);
    else p.log.info(`${file}: already registered`);
  }
  if (selected.includes("gemini")) {
    p.log.warn("Gemini CLI has no project MCP config path — register the server manually.");
  }

  // 4. Agent instruction files
  const touched = new Set<string>();
  for (const id of selected) {
    const file = AGENTS[id].agentFile;
    if (!file || touched.has(file)) continue;
    touched.add(file);
    const outcome = updateAgentFile(projectRoot, file);
    if (outcome !== "present") p.log.success(`${file}: snippet ${outcome}`);
  }

  p.outro(`Done. Run \`npx typegraph-mcp check\` to verify.`);
}

export async function remove(projectRoot: string): Promise<void> {
  p.intro("typegraph-mcp remove");

  const deregistered = deregisterMcp(projectRoot);
  for (const f of deregistered) p.log.success(`${path.relative(projectRoot, f) || f}: deregistered`);

  const removedSkills = removeSkills(projectRoot);
  if (removedSkills > 0) p.log.success(`Removed ${removedSkills} skill directories`);

  const touched = new Set<string>();
  for (const id of AGENT_IDS) {
    const file = AGENTS[id].agentFile;
    if (!file || touched.has(file)) continue;
    touched.add(file);
    if (removeAgentSnippet(projectRoot, file)) p.log.success(`${file}: snippet removed`);
  }

  // Only ever created by this tool's own earlier plugin-based installer.
  const legacy = path.resolve(projectRoot, LEGACY_PLUGIN_DIR);
  if (fs.existsSync(path.join(legacy, "src/server.ts"))) {
    fs.rmSync(legacy, { recursive: true, force: true });
    const plugins = path.dirname(legacy);
    if (fs.existsSync(plugins) && fs.readdirSync(plugins).length === 0) fs.rmdirSync(plugins);
    p.log.success(`${LEGACY_PLUGIN_DIR}/ removed (legacy plugin install)`);
  }

  for (const item of cleanupLegacyPluginInstall(projectRoot, "")) {
    p.log.success(`Legacy plugin cleanup: ${item}`);
  }

  p.outro("Removed.");
}
