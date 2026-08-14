import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "src/cli.cjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tg-check-project-"));

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

function makeProject(
  name: string,
  options: { readonly tsconfig: boolean; readonly typescript: "tool-symlink" | "ts5-stub" | "none" },
): string {
  const projectRoot = path.join(tempRoot, name);
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  if (options.typescript !== "none") {
    fs.mkdirSync(path.join(projectRoot, "node_modules"), { recursive: true });
    if (options.typescript === "tool-symlink") {
      fs.symlinkSync(
        path.join(repoRoot, "node_modules", "typescript"),
        path.join(projectRoot, "node_modules", "typescript"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } else {
      const tsRoot = path.join(projectRoot, "node_modules", "typescript");
      fs.mkdirSync(tsRoot, { recursive: true });
      fs.writeFileSync(
        path.join(tsRoot, "package.json"),
        JSON.stringify({ name: "typescript", version: "5.7.3" }, null, 2) + "\n",
      );
    }
  }
  fs.writeFileSync(path.join(projectRoot, "src/dependency.ts"), "export const dep = 1;\n");
  fs.writeFileSync(
    path.join(projectRoot, "src/index.ts"),
    'import { dep } from "./dependency.js";\nexport const value = dep + 1;\n',
  );
  if (options.tsconfig) {
    fs.writeFileSync(
      path.join(projectRoot, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            module: "Preserve",
            moduleResolution: "Bundler",
            target: "ES2022",
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ) + "\n",
    );
  }
  return projectRoot;
}

function runCheck(projectRoot: string, cwd: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "src/check.cjs")], {
    cwd,
    env: { ...process.env, TYPEGRAPH_PROJECT_ROOT: projectRoot },
    encoding: "utf-8",
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

function runCheckWithCliOptions(
  projectRoot: string,
  cwd: string,
): { status: number | null; output: string } {
  const env = { ...process.env };
  delete env["TYPEGRAPH_PROJECT_ROOT"];
  delete env["TYPEGRAPH_TSCONFIG"];
  const result = spawnSync(
    process.execPath,
    [cli, "check", "--project-root", projectRoot, "--tsconfig", "./tsconfig.json"],
    { cwd, env, encoding: "utf-8" },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function runCheckWithCliEqualsOptions(
  projectRoot: string,
  cwd: string,
): { status: number | null; output: string } {
  const env = { ...process.env };
  delete env["TYPEGRAPH_PROJECT_ROOT"];
  delete env["TYPEGRAPH_TSCONFIG"];
  const result = spawnSync(
    process.execPath,
    [cli, "check", `--project-root=${projectRoot}`, "--tsconfig=./tsconfig.json"],
    { cwd, env, encoding: "utf-8" },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

try {
  console.log("project environment checks");

  const goodProject = makeProject("good", { tsconfig: true, typescript: "tool-symlink" });
  const fromOutside = runCheck(goodProject, tempRoot);
  check("check can run outside the project cwd", fromOutside.status === 0, fromOutside.output);
  check("tsconfig is reported", fromOutside.output.includes("[  ok  ] tsconfig"), fromOutside.output);
  check("module graph is reported", fromOutside.output.includes("[  ok  ] module graph"), fromOutside.output);
  check(
    "semantic project opens",
    fromOutside.output.includes("[  ok  ] semantic project"),
    fromOutside.output,
  );

  const explicitCli = runCheckWithCliOptions(goodProject, tempRoot);
  check(
    "CLI project/tsconfig options work without environment variables",
    explicitCli.status === 0,
    explicitCli.output,
  );
  check(
    "CLI options target the requested project",
    explicitCli.output.includes(`project: ${goodProject}`) && explicitCli.output.includes("tsconfig.json exists"),
    explicitCli.output,
  );

  const explicitEqualsCli = runCheckWithCliEqualsOptions(goodProject, tempRoot);
  check(
    "CLI --flag=value options target the requested project",
    explicitEqualsCli.status === 0 &&
      explicitEqualsCli.output.includes(`project: ${goodProject}`) &&
      explicitEqualsCli.output.includes("tsconfig.json exists"),
    explicitEqualsCli.output,
  );

  const ts5Project = makeProject("ts5", { tsconfig: true, typescript: "ts5-stub" });
  const ts5 = runCheck(ts5Project, tempRoot);
  check("TypeScript 5 project passes through bundled TS7 fallback", ts5.status === 0, ts5.output);
  check("fallback provider is reported", ts5.output.includes("via typescript"), ts5.output);
  check(
    "TS5 project still opens semantically",
    ts5.output.includes("[  ok  ] semantic project"),
    ts5.output,
  );

  const missingTsconfig = makeProject("missing-tsconfig", { tsconfig: false, typescript: "none" });
  const missing = runCheck(missingTsconfig, tempRoot);
  check("missing tsconfig fails check", missing.status === 1, missing.output);
  check(
    "missing tsconfig message is explicit",
    missing.output.includes("[ FAIL ] tsconfig MISSING") &&
      missing.output.includes("TSGo semantic tools open an explicit tsconfig project"),
    missing.output,
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nOK — project checks are explicit" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
