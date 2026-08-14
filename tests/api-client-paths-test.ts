import assert from "node:assert";
import path from "node:path";
import { isProjectSourceFile } from "../src/api-client.ts";

console.log("project source-file containment");

assert.equal(
  isProjectSourceFile(
    String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\tg-nav-1234`,
    "C:/Users/RUNNER~1/AppData/Local/Temp/tg-nav-1234/src/widgets.ts",
    path.win32,
  ),
  true,
);
console.log("  ok  Windows separator differences preserve project files");

assert.equal(
  isProjectSourceFile(
    String.raw`C:\Users\RunnerAdmin\repo`,
    String.raw`c:\users\runneradmin\repo\src\widgets.ts`,
    path.win32,
  ),
  true,
);
console.log("  ok  Windows path casing is compared case-insensitively");

assert.equal(
  isProjectSourceFile("/workspace/app", "/workspace/application/src/leak.ts", path.posix),
  false,
);
assert.equal(
  isProjectSourceFile("/workspace/app", "/workspace/app/node_modules/pkg/index.ts", path.posix),
  false,
);
assert.equal(
  isProjectSourceFile("/workspace/app", "/workspace/app/src/generated.d.ts", path.posix),
  false,
);
console.log("  ok  siblings, dependencies, and declarations stay excluded");
