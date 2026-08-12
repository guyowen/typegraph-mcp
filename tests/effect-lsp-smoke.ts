/**
 * Effect-specific TSGo LSP smoke test against a real Effect project.
 *
 * Usage:
 *   node tests/effect-lsp-smoke.ts <projectRoot> [tsconfig]
 *
 * This is intentionally not part of `npm test`: the package itself does not
 * depend on `effect`, while these checks prove the richer @effect/tsgo hover,
 * diagnostics, code-action, and Layer graph surfaces against a project that
 * actually has Effect installed and configured.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
const tsconfig = process.argv[3] ?? "./tsconfig.json";
const repoRoot = path.resolve(import.meta.dirname, "..");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function connect(targetRoot: string, targetTsconfig: string): Promise<{
  client: Client;
  call: (name: string, args: Record<string, unknown>) => Promise<any>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "src/server.cjs")],
    cwd: targetRoot,
    env: {
      ...(process.env as Record<string, string>),
      TYPEGRAPH_PROJECT_ROOT: targetRoot,
      TYPEGRAPH_TSCONFIG: targetTsconfig,
    },
  });

  const client = new Client({ name: "effect-lsp-smoke", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    call: async (name, args) => {
      const res: any = await client.callTool({ name, arguments: args });
      return JSON.parse(res.content[0].text);
    },
  };
}

const realProject = await connect(projectRoot, tsconfig);
const { client, call } = realProject;

console.log(`Effect TSGo LSP smoke\n  project: ${projectRoot}\n  tsconfig: ${tsconfig}\n`);

const info = await call("ts_project_info", {});
check("project uses @effect/tsgo semantic provider", info.backend?.exe?.source === "@effect/tsgo", info.backend?.exe?.source);

const hover = await call("ts_hover", {
  file: "apps/gateway/lib/middleware/auth.ts",
  symbol: "requireHttpApiSession",
});
check(
  "ts_hover includes Effect type parameters",
  typeof hover.value === "string" && hover.value.includes("/* Effect Type Parameters */"),
  String(hover.value ?? "").slice(0, 160).replace(/\n/g, " | "),
);

const layerHover = await call("ts_layer_hover", {
  file: "apps/async-worker/src/index.ts",
  symbol: "AsyncWorkerTracingLayer",
});
check("ts_layer_hover identifies Layer hovers", layerHover.isLayerHover === true, JSON.stringify(layerHover));
check("Layer hover exposes graph links when TSGo provides them", layerHover.hasLayerGraph === true, JSON.stringify(layerHover));
check("Layer hover extracts Mermaid links", layerHover.mermaidLinks?.length > 0, JSON.stringify(layerHover.mermaidLinks));

const diagnostics = await call("ts_effect_diagnostics", {});
check("ts_effect_diagnostics returns a summary", !!diagnostics.summary, JSON.stringify(diagnostics));
check(
  "diagnostics are structured",
  typeof diagnostics.summary?.errors === "number" && typeof diagnostics.summary?.warnings === "number",
  JSON.stringify(diagnostics.summary),
);

const actions = await call("ts_code_actions", {
  file: "apps/gateway/lib/middleware/auth.ts",
  symbol: "requireHttpApiSession",
  only: ["refactor.rewrite"],
});
check("ts_code_actions returns normalized actions", Array.isArray(actions.actions), `${actions.count ?? "?"}`);
check(
  "code actions expose titles when available",
  actions.count === 0 || typeof actions.actions[0]?.title === "string",
  JSON.stringify(actions.actions?.[0] ?? null),
);

await client.close();

console.log("\nsynthetic diagnostic quick-fix fixture");
const effectPackage = path.join(projectRoot, "node_modules", "effect");
if (!fs.existsSync(effectPackage)) {
  check("real project has effect installed for fixture", false, effectPackage);
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-effect-lsp-"));
  try {
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "node_modules"), { recursive: true });
    fs.symlinkSync(effectPackage, path.join(tmp, "node_modules", "effect"), "dir");
    fs.symlinkSync(path.join(repoRoot, "node_modules", "typescript"), path.join(tmp, "node_modules", "typescript"), "dir");
    fs.writeFileSync(
      path.join(tmp, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            module: "Preserve",
            moduleResolution: "Bundler",
            target: "ES2022",
            plugins: [
              {
                name: "@effect/language-service",
                diagnostics: true,
                quickinfo: true,
                refactors: true,
                diagnosticSeverity: { floatingEffect: "error" },
              },
            ],
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ) + "\n",
    );
    fs.writeFileSync(
      path.join(tmp, "src/index.ts"),
      `import { Effect } from "effect"

export const program = Effect.gen(function* () {
  Effect.log("floating")
  return 1
})
`,
    );

    const synthetic = await connect(tmp, "./tsconfig.json");
    try {
      const syntheticDiagnostics = await synthetic.call("ts_effect_diagnostics", {});
      const floating = syntheticDiagnostics.diagnostics?.find((d: any) => d.name === "floatingEffect");
      check("synthetic fixture reports floatingEffect", !!floating, JSON.stringify(syntheticDiagnostics));
      check("diagnostic includes LSP-compatible range", !!floating?.range?.start?.line, JSON.stringify(floating));
      const quickFixes = await synthetic.call("ts_code_actions", {
        file: "src/index.ts",
        range: floating?.range,
        diagnostics: floating ? [floating] : [],
        only: ["quickfix"],
      });
      check(
        "diagnostic can feed ts_code_actions directly",
        quickFixes.actions?.some((action: any) => action.title === "Add yield* statement"),
        JSON.stringify(quickFixes.actions),
      );
    } finally {
      await synthetic.client.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? "\nOK — Effect TSGo LSP surfaces working" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
