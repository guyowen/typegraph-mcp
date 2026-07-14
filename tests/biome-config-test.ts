#!/usr/bin/env npx tsx

import * as assert from "node:assert/strict";
import { biomeScopeExcludes, patchBiomeConfig } from "../biome-config.js";

const broadConfig = `{
  "files": {
    "includes": ["**", "!dist"]
  }
}
`;
const patchedBroad = patchBiomeConfig(broadConfig, "plugins");
assert.ok(patchedBroad);
assert.deepEqual(JSON.parse(patchedBroad).files.includes, ["**", "!dist", "!!plugins"]);
assert.equal(biomeScopeExcludes(patchedBroad, "plugins"), true);

const defaultConfig = `{
  // Biome defaults to all supported files when files.includes is absent.
  "linter": { "enabled": true }
}
`;
const patchedDefault = patchBiomeConfig(defaultConfig, "plugins");
assert.ok(patchedDefault);
assert.match(patchedDefault, /"files": \{ "includes": \["\*\*", "!!plugins"\] \}/);
assert.equal(biomeScopeExcludes(patchedDefault, "plugins"), true);

const narrowConfig = `{
  "files": {
    "includes": ["src/**/*", ".vscode/**/*", "*.config.ts"]
  }
}
`;
assert.equal(biomeScopeExcludes(narrowConfig, "plugins"), true);

const explicitlyIgnoredConfig = `{
  "files": {
    "includes": ["**", "!!plugins"]
  }
}
`;
assert.equal(biomeScopeExcludes(explicitlyIgnoredConfig, "plugins"), true);

console.log("");
console.log("typegraph-mcp Biome Config Test");
console.log("===============================");
console.log("  ✓ broad scopes receive a plugins force-ignore");
console.log("  ✓ default scopes receive files.includes with a force-ignore");
console.log("  ✓ narrow scopes and explicit ignores are recognized without patching");
