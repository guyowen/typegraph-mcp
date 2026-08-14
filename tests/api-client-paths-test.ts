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

const shortRoot = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\tg-nav-1234`;
const longFile = String.raw`C:\Users\runneradmin\AppData\Local\Temp\tg-nav-1234\src\widgets.ts`;
const expandShortName = (value: string): string =>
  value.replace(String.raw`C:\Users\RUNNER~1`, String.raw`C:\Users\runneradmin`);
assert.equal(longFile.startsWith(shortRoot), false);
assert.equal(isProjectSourceFile(shortRoot, longFile, path.win32, expandShortName), true);
console.log("  ok  canonical paths reconcile Windows short and long names");

assert.equal(
  isProjectSourceFile(
    String.raw`C:\repo`,
    String.raw`\\?\C:\repo\src\widgets.ts`,
    path.win32,
  ),
  true,
);
console.log("  ok  Windows extended-length prefixes do not escape containment");

assert.equal(
  isProjectSourceFile("/workspace/app", "/workspace/application/src/leak.ts", path.posix),
  false,
);
assert.equal(
  isProjectSourceFile("/workspace/app", "/workspace/app/node_modules/pkg/index.ts", path.posix),
  false,
);
assert.equal(
  isProjectSourceFile("/workspace/app", "/workspace/app/Node_Modules/pkg/index.ts", path.posix),
  true,
);
assert.equal(
  isProjectSourceFile(
    String.raw`C:\workspace\app`,
    String.raw`C:\workspace\app\NODE_MODULES\pkg\index.ts`,
    path.win32,
  ),
  false,
);
assert.equal(
  isProjectSourceFile("/workspace/app", "/workspace/app/src/generated.d.ts", path.posix),
  false,
);
assert.equal(
  isProjectSourceFile("/workspace/app", "/workspace/app/src/generated.d.mts", path.posix),
  false,
);
assert.equal(
  isProjectSourceFile("/workspace/app", "/workspace/app/src/generated.d.cts", path.posix),
  false,
);
assert.equal(isProjectSourceFile("/workspace/app", "/workspace/app", path.posix), false);
console.log("  ok  siblings, dependencies, and declarations stay excluded");
