import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LspClient } from "../src/lsp-client.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-lsp-client-"));

let failures = 0;
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

try {
  console.log("LSP client process lifecycle");

  const dead = new LspClient("/usr/bin/true", tmp);
  const deadStart = await settles(dead.start());
  check("exited LSP rejects start instead of hanging", deadStart.settled === true && !!deadStart.message, deadStart.message);
  const deadStop = await settles(dead.stop());
  check("stop settles after an exited LSP", deadStop.settled === true, deadStop.message);

  const missing = new LspClient("/definitely/not/a/typegraph-tsgo-binary", tmp);
  const missingStart = await settles(missing.start());
  check("unspawnable LSP rejects start instead of crashing", missingStart.message?.includes("ENOENT") === true, missingStart.message);
  const missingStop = await settles(missing.stop());
  check("stop settles after an unspawnable LSP", missingStop.settled === true, missingStop.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nOK — LSP lifecycle failures settle" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
