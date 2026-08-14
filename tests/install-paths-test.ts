import assert from "node:assert";
import {
  portableNodePath,
  serverArgFor,
  supportsNativeTypeScript,
} from "../src/install-paths.ts";

console.log("runtime and portable server paths");

assert.equal(supportsNativeTypeScript("22.18.0"), true);
assert.equal(supportsNativeTypeScript("22.17.9"), false);
assert.equal(supportsNativeTypeScript("24.0.0"), true);
console.log("  ok  Node runtime floor is exact");

assert.equal(
  serverArgFor({
    packageRoot: String.raw`C:\repo\node_modules\typegraph-mcp`,
    absolute: String.raw`C:\repo\node_modules\typegraph-mcp\dist\server.cjs`,
    relative: String.raw`node_modules\typegraph-mcp\dist\server.cjs`,
    stable: true,
  }),
  "node_modules/typegraph-mcp/dist/server.cjs",
);
console.log("  ok  Windows project paths are portable in committed configs");

assert.equal(
  serverArgFor({
    packageRoot: "/opt/typegraph-mcp",
    absolute: "/opt/typegraph-mcp/dist/server.cjs",
    relative: null,
    stable: true,
  }),
  "/opt/typegraph-mcp/dist/server.cjs",
);
console.log("  ok  external checkout fallback remains absolute");

assert.equal(
  portableNodePath(String.raw`C:\Users\example\typegraph-mcp\dist\cli.cjs`),
  "C:/Users/example/typegraph-mcp/dist/cli.cjs",
);
console.log("  ok  Windows external-checkout skill paths use portable separators");
