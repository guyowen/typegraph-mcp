# AGENTS.md

Compact instructions for OpenCode sessions working in this repo.

## About

MCP server providing 14 TypeScript semantic navigation tools for AI coding agents. Two subsystems: tsserver (semantic queries) + oxc-parser/oxc-resolver (import graph).

## Setup

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
npx tsx error-path-test.ts        # error path coverage test
```

## Development

- Root files serve as thin re-exports for backward compatibility after module extraction
- Barrel exports: `src/core/index.ts` (tsserver + graph), `src/core/graph/index.ts` (graph module)
- `_pm/` directory for PARA methodology tracking (Projects, Areas, Resources, Archives)
- Dynamic imports in `cli.ts` for `setup`/`remove` keep startup fast

## Architecture

- `server.ts` — MCP server entry point (270 lines), imports from barrel exports in `src/`
- `cli.ts` — thin dispatch (264 lines), dynamic imports for `setup`/`remove`
- `src/cli/setup.ts` — main setup command (863 lines)
- `src/cli/remove.ts` — remove command (345 lines)
- `src/cli/agents/` — agent types, constants, registry, TOML helpers
- `src/core/tsserver/client.ts` — tsserver protocol bridge (442 lines)
- `src/core/graph/builder.ts` — import graph build with oxc-parser + fs.watch (742 lines)
- `src/core/graph/queries.ts` — pure graph traversals (BFS, Tarjan SCC) (478 lines)
- `src/core/index.ts` — barrel export for core module
- `src/core/graph/index.ts` — barrel export for graph module
- `src/shared/config.ts` — project root detection + Zod validation (130 lines)
- `src/health/checker.ts` — 12 health checks (796 lines)
- `src/server/` — server module (graph.ts 240, navigation.ts 399, types.ts 39, index.ts 9)
- `check.ts` — thin re-export to `src/health/checker.ts`
- `config.ts` — thin re-export to `src/shared/config.ts`
- `tsserver-client.ts` — thin re-export to `src/core/tsserver/client.ts`
- `module-graph.ts` — thin re-export to `src/core/graph/builder.ts`
- `graph-queries.ts` — thin re-export to `src/core/graph/queries.ts`
- `export-resolver.ts` — module export analysis (extracted from server.ts)
- `tsconfig-patch.ts` — tsconfig.json and lint config patching

Supported agents: Claude Code, Cursor, Codex CLI, Gemini CLI, GitHub Copilot, OpenCode.

## Testing

- `error-path-test.ts` — 15 assertions covering 11 error paths
- `setup-test.ts` — validates 20 core files copied correctly during plugin install
- 7 test suites pass: smoke, export-surface, engine-sync, install-oxlint, opencode, setup, error-path

## Technologies

- TypeScript with tsx for direct execution
- oxc-parser + oxc-resolver for import graph
- Zod for schema validation
- fs.watch for file change detection in module graph
- tsup for build compilation to dist/

## Rules

- **Backward compatibility** — root files serve as thin re-exports after module extraction
- **CORE_FILES list in cli.ts**: must include new `.ts` modules for plugin installs
- **tsup.config.ts entry array**: must include new modules for build
- **Plugin directory**: `plugins/typegraph-mcp/` in target projects
- **MCP config patterns**: JSON for Cursor/Copilot/OpenCode, TOML for Codex CLI
- **tsconfig.json** — exists in repo root with strict mode, path aliases (`@core/*`, `@cli/*`, `@shared/*`, `@server/*`, `@health/*`), and `src/**/*.ts` include

## Known Issues

- `cli.ts` has `isDirectRun` guard — importing cli.ts as module triggers CLI dispatch unless guarded
- `getModuleExports` in export-resolver.ts needs `client`, `moduleResolver`, `projectRoot`, `relPathFn`, `resolveProjectImportFn` — 6 params
- Large projects (1000+ files) may hit tsserver timeout on `ts_references` — 60s timeout set
- `install-oxlint-test.ts` runs `cli.ts setup --yes` in temp dir — needs `tsconfig-patch.ts` in CORE_FILES
- `reverseIndex` in ModuleGraph — must maintain consistency in `updateFile` and `removeFile` (now in `src/core/graph/builder.ts`)
- Dynamic imports in cli.ts for setup/remove keep startup fast

## Notes

- **tsserver timeout**: 60s (increased for large projects)
