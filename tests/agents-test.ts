/**
 * Covering-set tests for skill routing.
 *
 * The case that motivated this: OpenCode reads BOTH .claude/skills/ and
 * .agents/skills/, and Cursor reads those two plus .cursor/skills/. A naive
 * per-agent write would put skills in several directories at once whenever one
 * of them is selected alongside Claude Code or Codex, and the flexible agent
 * would then discover every skill more than once.
 */
import assert from "node:assert";
import {
  AGENTS,
  AGENT_IDS,
  agentsServedBy,
  buildMcpEntry,
  computeSkillTargets,
  projectJsonMcpConfigs,
  SKILLS_DIR_PATHS,
  type AgentId,
} from "../src/agents.ts";

let passed = 0;
const test = (name: string, fn: () => void): void => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
};

const sorted = (ids: AgentId[]): string[] => computeSkillTargets(ids).sort();

console.log("skill target routing");

test("claude-code alone -> .claude/skills only", () => {
  assert.deepStrictEqual(sorted(["claude-code"]), ["claude"]);
});

test("cursor alone -> .cursor/skills, its native location", () => {
  assert.deepStrictEqual(sorted(["cursor"]), ["cursor"]);
});

test("codex alone -> .agents/skills only", () => {
  assert.deepStrictEqual(sorted(["codex"]), ["agents"]);
});

test("opencode alone -> single dir, prefers .claude", () => {
  assert.deepStrictEqual(sorted(["opencode"]), ["claude"]);
});

test("opencode + codex -> ONE dir, not two (no double discovery)", () => {
  assert.deepStrictEqual(sorted(["opencode", "codex"]), ["agents"]);
});

test("opencode + claude-code -> ONE dir", () => {
  assert.deepStrictEqual(sorted(["opencode", "claude-code"]), ["claude"]);
});

test("cursor + claude-code -> ONE dir; cursor reads .claude for compat", () => {
  assert.deepStrictEqual(sorted(["cursor", "claude-code"]), ["claude"]);
});

test("cursor + codex -> ONE dir", () => {
  assert.deepStrictEqual(sorted(["cursor", "codex"]), ["agents"]);
});

test("claude-code + codex -> both, they share nothing", () => {
  assert.deepStrictEqual(sorted(["claude-code", "codex"]), ["agents", "claude"]);
});

test("flexible agents ride along when claude-code and codex are both present", () => {
  assert.deepStrictEqual(sorted(["opencode", "cursor", "claude-code", "codex"]), ["agents", "claude"]);
});

test("all agents -> two directories, never three", () => {
  assert.deepStrictEqual(sorted(AGENT_IDS), ["agents", "claude"]);
});

test("every agent is covered by at least one written target", () => {
  const targets = computeSkillTargets(AGENT_IDS);
  for (const id of AGENT_IDS) {
    const reads = AGENTS[id].skillsReadsFrom;
    assert.ok(
      reads.some((d) => targets.includes(d)),
      `${id} reads ${reads.join("|")} but targets are ${targets.join("|")}`,
    );
  }
});

test("each agent is attributed to exactly one target", () => {
  const targets = computeSkillTargets(AGENT_IDS);
  const counts = new Map<string, number>();
  for (const t of targets) {
    for (const name of agentsServedBy(AGENT_IDS, t)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  for (const [name, n] of counts) {
    assert.strictEqual(n, 1, `${name} attributed to ${n} targets`);
  }
  assert.strictEqual(counts.size, AGENT_IDS.length, "every agent attributed");
});

test("every skills directory is project-relative — no plugin dir remains", () => {
  for (const [name, dir] of Object.entries(SKILLS_DIR_PATHS)) {
    assert.ok(!dir.startsWith("/"), `${name} -> ${dir} must be relative`);
    assert.ok(!dir.includes("plugin"), `${name} -> ${dir} must not be a plugin dir`);
  }
});

console.log("\nmcp registration");

test("claude-code registers through project .mcp.json, not a plugin", () => {
  const reg = AGENTS["claude-code"].mcp;
  assert.strictEqual(reg.kind, "json");
  assert.strictEqual(reg.kind === "json" && reg.file, ".mcp.json");
  assert.strictEqual(reg.kind === "json" && reg.rootKey, "mcpServers");
});

test("no agent is global-scoped", () => {
  const global = AGENT_IDS.filter((id) => {
    const reg = AGENTS[id].mcp;
    return reg.kind !== "none" && reg.scope === "global";
  });
  assert.deepStrictEqual(global, []);
});

test("projectJsonMcpConfigs covers every project JSON config once", () => {
  const files = projectJsonMcpConfigs().map((c) => c.file).sort();
  assert.deepStrictEqual(files, [".agents/mcp_config.json", ".cursor/mcp.json", ".mcp.json", ".vscode/mcp.json", "opencode.json"]);
});

console.log("\nmcp entry shapes");

const cmd = { command: "node", args: ["server.js"] };

test("cursor shape is command+args", () => {
  assert.deepStrictEqual(buildMcpEntry("command-args", cmd), {
    command: "node",
    args: ["server.js"],
  });
});

test("copilot shape adds type stdio", () => {
  assert.deepStrictEqual(buildMcpEntry("command-args-stdio", cmd), {
    type: "stdio",
    command: "node",
    args: ["server.js"],
  });
});

test("opencode shape collapses command into ONE array", () => {
  assert.deepStrictEqual(buildMcpEntry("opencode", cmd), {
    type: "local",
    command: ["node", "server.js"],
    enabled: true,
  });
});

console.log(`\n${passed} passed`);
