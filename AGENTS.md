# AGENTS.md

Compact instructions for OpenCode sessions working in this repo.

## Project Identity

MCP server providing 14 TypeScript semantic navigation tools for AI coding agents. Two subsystems: tsserver (semantic queries) + oxc-parser/oxc-resolver (import graph).

## Commands

```bash
npm install --include=optional   # install deps (including optional oxc packages)
npm test                          # run all 5 test suites
npm run check                     # 12 health checks
npm run build                     # compile to dist/ via tsup
npx tsx server.ts                 # start MCP server (stdin/stdout)
```

Single test suite:

```bash
npx tsx smoke-test.ts             # tools smoke test
npx tsx opencode-test.ts          # opencode agent tests
npx tsx export-surface-test.ts    # module export surface tests
```

## Architecture

- `server.ts` — MCP server entry, 14 tool definitions, ~900 lines
- `cli.ts` — setup/remove/check/test commands, ~1375 lines
- `tsserver-client.ts` — tsserver protocol bridge (child process pipes)
- `module-graph.ts` — import graph build with oxc-parser + fs.watch
- `graph-queries.ts` — pure graph traversals (BFS, Tarjan SCC)
- `export-resolver.ts` — module export analysis extracted from server.ts
- `config.ts` — project root detection (3-level fallback)
- `tsconfig-patch.ts` — tsconfig.json and lint config patching

Supported agents: Claude Code, Cursor, Codex CLI, Gemini CLI, GitHub Copilot, OpenCode.

## Key Facts

- **No tsconfig.json in repo root** — project uses tsx for direct execution
- **tsserver timeout**: 60s (increased for large projects)
- **CORE_FILES list in cli.ts**: must include new `.ts` modules for plugin installs
- **tsup.config.ts entry array**: must include new modules for build
- **Plugin directory**: `plugins/typegraph-mcp/` in target projects
- **MCP config patterns**: JSON for Cursor/Copilot/OpenCode, TOML for Codex CLI

## Gotchas

- `cli.ts` has `isDirectRun` guard — importing cli.ts as module triggers CLI dispatch unless guarded
- `getModuleExports` in export-resolver.ts needs `client`, `moduleResolver`, `projectRoot`, `relPathFn`, `resolveProjectImportFn` — 6 params
- Large projects (1000+ files) may hit tsserver timeout on `ts_references` — 60s timeout set
- `install-oxlint-test.ts` runs `cli.ts setup --yes` in temp dir — needs `tsconfig-patch.ts` in CORE_FILES
- `reverseIndex` in ModuleGraph — must maintain consistency in `updateFile` and `removeFile`

## TypeScript Navigation (typegraph-mcp)

Where suitable, use the `ts_*` MCP tools instead of grep/glob for navigating TypeScript code. They resolve through barrel files, re-exports, and project references and return semantic results instead of string matches.

- Point queries: `ts_find_symbol`, `ts_definition`, `ts_references`, `ts_type_info`, `ts_navigate_to`, `ts_trace_chain`, `ts_blast_radius`, `ts_module_exports`
- Graph queries: `ts_dependency_tree`, `ts_dependents`, `ts_import_cycles`, `ts_shortest_path`, `ts_subgraph`, `ts_module_boundary`

Start with the navigation tools before reading entire files. Use direct file reads only after the MCP tools identify the exact symbols or lines that matter.

For quick architectural insight, prefer composition modules and entrypoints over top-level barrel files. If `ts_module_exports` on an `index.ts` or other barrel looks empty or uninformative, pivot to the app entrypoint, router, handler, service composition root, or API module that wires real behavior together.

Use `rg` or `grep` when semantic symbol navigation is not the right tool, especially for:

- docs, config, SQL, migrations, JSON, env vars, route strings, and other non-TypeScript assets
- broad text discovery when you do not yet know the symbol name
- exact string matching across the repo
- validating wording or finding repeated plan/document references

Practical rule:

- use `ts_*` first for TypeScript symbol definition, references, types, and dependency analysis
- use `rg`/`grep` for text search and non-TypeScript exploration
- combine both when a task spans TypeScript code and surrounding docs/config
