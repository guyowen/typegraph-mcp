import assert from "node:assert";
import { fnmDefaultInterpreter } from "../src/install-paths.ts";

console.log("fnm default interpreter paths");

assert.equal(
  fnmDefaultInterpreter(
    "/Users/example/.local/share/fnm/node-versions/v24.11.0/installation/bin/node",
  ),
  "/Users/example/.local/share/fnm/aliases/default/bin/node",
);
console.log("  ok  POSIX version path resolves through the default alias");

assert.equal(
  fnmDefaultInterpreter(
    String.raw`C:\Users\example\AppData\Roaming\fnm\node-versions\v24.11.0\installation\node.exe`,
  ),
  String.raw`C:\Users\example\AppData\Roaming\fnm\aliases\default\node.exe`,
);
console.log("  ok  Windows version path resolves through the default alias");

assert.equal(fnmDefaultInterpreter("/usr/local/bin/node"), undefined);
console.log("  ok  unmanaged interpreter is left alone");
