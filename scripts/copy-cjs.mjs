import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const entries = ["cli.cjs", "server.cjs", "check.cjs", "run-ts.cjs"];

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
for (const entry of entries) {
  fs.copyFileSync(path.join(root, "src", entry), path.join(root, "dist", entry));
}
