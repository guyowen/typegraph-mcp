import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LspClient } from "../src/lsp-client.ts";
import { removeTempTree } from "./test-fs.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-lsp-client-"));
const fakeLsp = path.join(tmp, "fake-lsp.cjs");
const exitMarker = path.join(tmp, "fake-lsp-exited");
const hungPidFile = path.join(tmp, "fake-lsp-hung.pid");
fs.writeFileSync(
  fakeLsp,
  `const fs = require("node:fs");
const hangs = process.argv.includes("--hang-shutdown");
if (hangs) {
  fs.writeFileSync(${JSON.stringify(hungPidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
}
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write("Content-Length: " + body.length + "\\r\\n\\r\\n");
  process.stdout.write(body);
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) return;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
    buffer = buffer.subarray(start + length);
    if (message.id != null && !(message.method === "shutdown" && hangs)) send({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { capabilities: {} } : null });
    if (message.method === "exit") setTimeout(() => { fs.writeFileSync(${JSON.stringify(exitMarker)}, "done"); process.exit(0); }, 100);
  }
});
`,
);

let failures = 0;
let hungPid: number | undefined;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const settles = async (promise: Promise<unknown>, ms = 1000): Promise<{ settled: boolean; message?: string }> => {
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("__timeout__")), ms)),
    ]);
    return { settled: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { settled: message !== "__timeout__", message };
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

try {
  console.log("LSP client process lifecycle");

  const graceful = new LspClient(process.execPath, tmp, [fakeLsp]);
  await graceful.start();
  const gracefulStop = await settles(graceful.stop());
  check("stop awaits the graceful child exit", gracefulStop.settled === true && fs.existsSync(exitMarker), gracefulStop.message);

  const hung = new LspClient(process.execPath, tmp, [fakeLsp, "--hang-shutdown"]);
  await hung.start();
  hungPid = Number(fs.readFileSync(hungPidFile, "utf8"));
  const hungStop = await settles(hung.stop(), 3000);
  check(
    "stop force-closes an LSP that never answers shutdown",
    hungStop.settled === true && !isProcessAlive(hungPid),
    hungStop.message,
  );

  const dead = new LspClient(process.execPath, tmp);
  const deadStart = await settles(dead.start());
  check("exited LSP rejects start instead of hanging", deadStart.settled === true && !!deadStart.message, deadStart.message);
  const deadStop = await settles(dead.stop(), 3000);
  check("stop settles after an exited LSP", deadStop.settled === true, deadStop.message);

  const missing = new LspClient(path.join(tmp, "definitely-not-a-typegraph-tsgo-binary"), tmp);
  const missingStart = await settles(missing.start());
  check("unspawnable LSP rejects start instead of crashing", missingStart.message?.includes("ENOENT") === true, missingStart.message);
  const missingStop = await settles(missing.stop(), 3000);
  check("stop settles after an unspawnable LSP", missingStop.settled === true, missingStop.message);
} finally {
  if (hungPid !== undefined && isProcessAlive(hungPid)) process.kill(hungPid, "SIGKILL");
  removeTempTree(tmp);
}

console.log(failures === 0 ? "\nOK — LSP lifecycle failures settle" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
