/**
 * The no-flag entry point.
 *
 * `typegraph-mcp` with stdio piped must speak MCP; with a TTY on stdin it must
 * print usage instead. Both halves are easy to break by accident:
 *
 *  - a top-level import of the installer would put @clack/prompts in the
 *    server's module graph, and anything it writes to stdout corrupts the
 *    JSON-RPC stream in a way that surfaces as an unparseable-message error
 *    inside the client, not as a stack trace here;
 *  - losing the TTY branch turns `npx typegraph-mcp` into a process that sits
 *    silently reading stdin, which reads as a hang.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "src/cli.cjs");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

function serveOnce(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, TYPEGRAPH_PROJECT_ROOT: ".", TYPEGRAPH_TSCONFIG: "./tsconfig.json" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.write(JSON.stringify(INITIALIZE) + "\n");
    setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr });
    }, 8000);
  });
}

console.log("no arguments, stdio piped");
const piped = await serveOnce([]);
const firstLine = piped.stdout.split("\n")[0] ?? "";
check("responds at all", firstLine.length > 0, firstLine.slice(0, 60));

let parsed: any;
try {
  parsed = JSON.parse(firstLine);
} catch {
  parsed = undefined;
}
check("first stdout line is valid JSON-RPC — nothing else wrote to stdout", parsed !== undefined);
check("it is the initialize result", parsed?.result?.serverInfo?.name === "typegraph-mcp", parsed?.result?.serverInfo?.name);

console.log("\nexplicit `serve`");
const explicit = await serveOnce(["serve"]);
check(
  "same behaviour as no arguments",
  JSON.parse(explicit.stdout.split("\n")[0] ?? "{}")?.result?.serverInfo?.name === "typegraph-mcp",
);

console.log("\nno arguments, stdin is a TTY");
// `script` allocates a pty, but needs a controlling terminal to inherit from —
// which a test runner does not have. Reported as skipped rather than quietly
// dropped, so a green suite never implies this branch was exercised.
let tty: string | undefined;
try {
  tty = execFileSync("script", ["-q", "/dev/null", process.execPath, cli], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["inherit", "pipe", "pipe"],
  });
} catch {
  console.log("  skip  no controlling terminal — run this file from a shell to cover it");
}
if (tty !== undefined) {
  check("prints usage", tty.includes("typegraph-mcp setup"), tty.split("\n")[0]?.slice(0, 50));
  check("does NOT start a server", !tty.includes("jsonrpc"));
}

console.log("\nbin wiring");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
check("typegraph-mcp -> cli", pkg.bin["typegraph-mcp"] === "./dist/cli.cjs", pkg.bin["typegraph-mcp"]);
check("typegraph compatibility alias -> cli", pkg.bin["typegraph"] === "./dist/cli.cjs", pkg.bin["typegraph"]);
check(
  "typegraph-mcp-server -> direct server",
  pkg.bin["typegraph-mcp-server"] === "./dist/server.cjs",
  pkg.bin["typegraph-mcp-server"],
);

const help = execFileSync(process.execPath, [cli, "--help"], {
  cwd: repoRoot,
  encoding: "utf-8",
});
check("--help exits cleanly", help.includes("typegraph-mcp setup"), help.slice(0, 80));

console.log("\ninstaller is not in the server's module graph");
const cliSource = fs.readFileSync(path.join(repoRoot, "src/cli.ts"), "utf-8");
const staticImports = [...cliSource.matchAll(/^import\s+[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
check(
  "cli.ts statically imports nothing but node builtins",
  staticImports.every((s) => s!.startsWith("node:")),
  staticImports.join(", "),
);

console.log(failures === 0 ? "\nOK — no-flag dispatch intact" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
