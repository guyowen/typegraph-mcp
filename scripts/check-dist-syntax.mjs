import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

for (const name of fs.readdirSync("dist")) {
  if (!name.endsWith(".js") && !name.endsWith(".cjs")) continue;
  const result = spawnSync(process.execPath, ["--check", path.join("dist", name)], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
