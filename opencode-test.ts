#!/usr/bin/env npx tsx

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectAgents,
  registerOpenCodeMcp,
  deregisterOpenCodeMcp,
  type AgentId,
} from "./cli.js";

function assertIncludes(text: string, expected: string): void {
  assert.ok(
    text.includes(expected),
    `Expected output to include:\n${expected}\n\nActual output:\n${text}`,
  );
}

async function main(): Promise<void> {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "typegraph-opencode-"),
  );

  try {
    console.log("");
    console.log("typegraph-mcp OpenCode Test");
    console.log("===========================");
    console.log(`Temp dir: ${tempRoot}`);
    console.log("");

    // ─── detectAgents tests ──────────────────────────────────────────────

    console.log("── detectAgents ─────────────────────────────────────────");

    // No config files
    const emptyDir = path.join(tempRoot, "empty");
    fs.mkdirSync(emptyDir);
    const detectedEmpty = detectAgents(emptyDir);
    assert.deepEqual(
      detectedEmpty,
      [],
      "Expected no agents detected in empty directory",
    );
    console.log("  ✓ empty directory detects no agents");

    // opencode.json only
    const opencodeDir = path.join(tempRoot, "opencode");
    fs.mkdirSync(opencodeDir);
    fs.writeFileSync(path.join(opencodeDir, "opencode.json"), "{}");
    const detectedOpenCode = detectAgents(opencodeDir);
    assert.ok(
      detectedOpenCode.includes("opencode"),
      "Expected opencode detected",
    );
    assert.equal(detectedOpenCode.length, 1, "Expected only opencode detected");
    console.log("  ✓ opencode.json detects opencode");

    // opencode.jsonc
    const opencodeJsoncDir = path.join(tempRoot, "opencode-jsonc");
    fs.mkdirSync(opencodeJsoncDir);
    fs.writeFileSync(path.join(opencodeJsoncDir, "opencode.jsonc"), "{}");
    const detectedOpenCodeJsonc = detectAgents(opencodeJsoncDir);
    assert.ok(
      detectedOpenCodeJsonc.includes("opencode"),
      "Expected opencode detected from .jsonc",
    );
    console.log("  ✓ opencode.jsonc detects opencode");

    // Multiple agents
    const multiDir = path.join(tempRoot, "multi");
    fs.mkdirSync(multiDir);
    fs.writeFileSync(path.join(multiDir, "opencode.json"), "{}");
    fs.writeFileSync(path.join(multiDir, "CLAUDE.md"), "");
    const detectedMulti = detectAgents(multiDir);
    assert.ok(
      detectedMulti.includes("opencode"),
      "Expected opencode in multi-agent",
    );
    assert.ok(
      detectedMulti.includes("claude-code"),
      "Expected claude-code in multi-agent",
    );
    console.log("  ✓ multiple agent files detected correctly");

    // ─── registerOpenCodeMcp tests ───────────────────────────────────────

    console.log("");
    console.log("── registerOpenCodeMcp ──────────────────────────────────");

    // Register to new file
    const registerDir = path.join(tempRoot, "register");
    fs.mkdirSync(
      path.join(registerDir, "plugins/typegraph-mcp/node_modules/.bin"),
      {
        recursive: true,
      },
    );
    registerOpenCodeMcp(registerDir);

    const configPath = path.join(registerDir, "opencode.json");
    assert.ok(fs.existsSync(configPath), "Expected opencode.json created");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.ok(config.mcp?.typegraph, "Expected mcp.typegraph in config");
    assert.equal(
      config.mcp.typegraph.type,
      "local",
      "Expected type to be local",
    );
    assert.ok(
      Array.isArray(config.mcp.typegraph.command),
      "Expected command to be array",
    );
    assert.ok(
      config.mcp.typegraph.command[0].includes("tsx"),
      "Expected tsx in command",
    );
    assert.ok(
      config.mcp.typegraph.command[1].includes("server.ts"),
      "Expected server.ts in command",
    );
    assert.equal(
      config.mcp.typegraph.environment.TYPEGRAPH_PROJECT_ROOT,
      registerDir,
      "Expected TYPEGRAPH_PROJECT_ROOT",
    );
    console.log("  ✓ creates opencode.json with correct MCP config");

    // Register preserves existing config
    const existingDir = path.join(tempRoot, "existing");
    fs.mkdirSync(existingDir);
    fs.writeFileSync(
      path.join(existingDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: { other: { type: "remote", url: "https://example.com" } },
      }),
    );
    registerOpenCodeMcp(existingDir);

    const existingConfig = JSON.parse(
      fs.readFileSync(path.join(existingDir, "opencode.json"), "utf-8"),
    );
    assert.ok(
      existingConfig.mcp.other,
      "Expected existing MCP server preserved",
    );
    assert.ok(existingConfig.mcp.typegraph, "Expected typegraph added");
    assert.equal(
      existingConfig.$schema,
      "https://opencode.ai/config.json",
      "Expected $schema preserved",
    );
    console.log("  ✓ preserves existing opencode.json config");

    // Register handles invalid JSON gracefully
    const invalidDir = path.join(tempRoot, "invalid");
    fs.mkdirSync(invalidDir);
    fs.writeFileSync(path.join(invalidDir, "opencode.json"), "not json{{{");
    registerOpenCodeMcp(invalidDir);
    // Should not throw, should warn
    console.log("  ✓ handles invalid JSON gracefully");

    // ─── deregisterOpenCodeMcp tests ─────────────────────────────────────

    console.log("");
    console.log("── deregisterOpenCodeMcp ────────────────────────────────");

    // Deregister removes typegraph entry
    const deregisterDir = path.join(tempRoot, "deregister");
    fs.mkdirSync(deregisterDir);
    fs.writeFileSync(
      path.join(deregisterDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          typegraph: { type: "local", command: ["tsx", "server.ts"] },
          other: { type: "remote", url: "https://example.com" },
        },
      }),
    );
    deregisterOpenCodeMcp(deregisterDir);

    const deregistered = JSON.parse(
      fs.readFileSync(path.join(deregisterDir, "opencode.json"), "utf-8"),
    );
    assert.ok(!deregistered.mcp.typegraph, "Expected typegraph removed");
    assert.ok(deregistered.mcp.other, "Expected other MCP server preserved");
    console.log("  ✓ removes typegraph entry, preserves others");

    // Deregister removes file when empty
    const emptyAfterDir = path.join(tempRoot, "empty-after");
    fs.mkdirSync(emptyAfterDir);
    fs.writeFileSync(
      path.join(emptyAfterDir, "opencode.json"),
      JSON.stringify({
        mcp: { typegraph: { type: "local", command: ["tsx", "server.ts"] } },
      }),
    );
    deregisterOpenCodeMcp(emptyAfterDir);
    assert.ok(
      !fs.existsSync(path.join(emptyAfterDir, "opencode.json")),
      "Expected opencode.json removed when empty",
    );
    console.log("  ✓ removes opencode.json when no config remains");

    // Deregister handles missing file
    const missingDir = path.join(tempRoot, "missing");
    fs.mkdirSync(missingDir);
    deregisterOpenCodeMcp(missingDir);
    console.log("  ✓ handles missing opencode.json gracefully");

    // Deregister handles no typegraph entry
    const noTypegraphDir = path.join(tempRoot, "no-typegraph");
    fs.mkdirSync(noTypegraphDir);
    fs.writeFileSync(
      path.join(noTypegraphDir, "opencode.json"),
      JSON.stringify({
        mcp: { other: { type: "remote", url: "https://example.com" } },
      }),
    );
    deregisterOpenCodeMcp(noTypegraphDir);

    const noTypegraphConfig = JSON.parse(
      fs.readFileSync(path.join(noTypegraphDir, "opencode.json"), "utf-8"),
    );
    assert.ok(
      noTypegraphConfig.mcp.other,
      "Expected existing config unchanged",
    );
    console.log("  ✓ handles missing typegraph entry gracefully");

    console.log("");
    console.log("All tests passed!");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
