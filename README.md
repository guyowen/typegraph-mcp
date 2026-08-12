# typegraph-mcp

Type-aware codebase navigation for AI coding agents, on TypeScript 7.

This server drives **tsgo** via `@effect/tsgo` in `--api` mode, with an LSP supplement for editor-style hover, Effect diagnostics/code actions, project-wide local-symbol search, and document symbols. It is built for codebases that have moved to TypeScript 7 and need semantic TypeScript navigation through MCP.

Status: **working end to end.** All 22 MCP tools implemented, verified against a real project on `@effect/tsgo` 0.32.1 / `typescript` 7.0.2. The published package runs compiled `dist/` entrypoints, with no `tsx` runtime dependency. `tsc --noEmit` is clean.

Installed as skills + an MCP entry per agent. Nothing is copied into your project but SKILL.md files — see [Install model](#install-model-skills--mcp-config-nothing-else).

## Why TSGo

TSGo has no `tsserver` entrypoint. It exposes a separate `--api` RPC surface for semantic checker/program operations and an LSP surface for editor-style queries. TypeGraph-Go uses both deliberately:

- `--api` powers definitions, references, raw checker type info, module exports, trace-chain, blast-radius, and the exact export index.
- LSP powers editor-style hover, code actions, optional local-symbol search, and document symbols, including route-table and handler-map keys that project-wide export indexes do not see.
- `@effect/tsgo diagnostics --format json` powers structured Effect Language Service diagnostics.

## Architecture

```
MCP client (Claude Code, OpenCode, Codex, …)
        │
        ├── 7 point-query tools  ──► src/api-client.ts
        │                             typescript/unstable/async
        │                             └─► effect-tsgo --api   (JSON-RPC + msgpack)
        │
        ├── 4 LSP tools          ──► src/lsp-client.ts   (hover, Layer hover, code actions)
        │                             └─► effect-tsgo --lsp
        │
        ├── diagnostics          ──► @effect/tsgo diagnostics --format json
        │
        ├── ts_navigate_to       ──► src/navigate-to.ts  (export index + LSP coordinates/locals)
        │
        ├── 4 agent helper tools ──► composites over semantic + graph backends
        │
        └── 6 graph tools        ──► oxc-parser / oxc-resolver   (version-independent)
```

The binary comes from `@effect/tsgo` rather than `typescript`, because `--api` survives Effect's patch set untouched (`_patches/typescript-go/001-cmd-tsgo-main.patch` only *adds* a case) while their checker and hover patches make type display Effect-aware. Falls back to typescript's own binary when `@effect/tsgo` isn't installed.

## Tool surface

Point and navigation tools:

- `ts_find_symbol`
- `ts_definition`
- `ts_references`
- `ts_type_info`
- `ts_hover`
- `ts_layer_hover`
- `ts_effect_diagnostics`
- `ts_code_actions`
- `ts_navigate_to`
- `ts_trace_chain`
- `ts_blast_radius`
- `ts_module_exports`

Agent helper tools:

- `ts_project_info` — confirm project root, tsconfig, backend, export-index size, and graph size.
- `ts_document_symbols` — inspect one file's symbols, including object-literal keys.
- `ts_symbol_overview` — one-call definition, type, reference summary, and blast radius for a symbol.
- `ts_dead_exports` — possible unused exports in one module.

Graph tools:

- `ts_dependency_tree`
- `ts_dependents`
- `ts_import_cycles`
- `ts_shortest_path`
- `ts_subgraph`
- `ts_module_boundary`

## Version pinning is load-bearing

`tsgo --api` has **no protocol version handshake**, and its encoders are code-generated. A client/server mismatch surfaces as msgpack decode errors mid-request, not a clean error.

`typescript` is therefore pinned **exact** to `7.0.2` — the version `@effect/tsgo` pins on its `latest` channel (`_packages/tsgo/upstream.json` → gitHead `2bd066d`). `src/version-guard.ts` reads that manifest at runtime and refuses to start on a mismatch.

## `ts_navigate_to`

Benchmarked both viable strategies on a 1506-file fixture (~9000 exports, 3000 non-exported locals):

| | export index (API) | `workspace/symbol` (LSP) |
|---|---|---|
| Coverage | module exports only | every declaration, incl. locals + methods |
| Matching | exact substring | fuzzy subsequence |
| Result cap | none | **256, hard-coded, unflagged** |
| Build cost | ~0.13 ms/file (191ms @ 1506) | none |
| Query | <1ms | 2–6ms |

The index is the default. The 256 cap (`typescript-go` `internal/ls/symbols.go:558`) is silent, and at 1506 files *every* non-trivial query saturated it — which would quietly break the `deep-survey` skill's Phase 3b, where `ts_navigate_to` is used to *count* pattern prevalence.

`includeLocals: true` opts into the LSP path. The result reports `exportHits` and `localHits` separately, with `localsTruncated` scoped to the LSP half — a single blanket `truncated` flag would push callers to discard exact export counts alongside the capped local ones.

`maxResults` (default 10) trims the returned **list**, sorted best-match first, and leaves every count describing the full set. `listTrimmed` therefore means something different from `localsTruncated`: one shortens a list, the other invalidates a count. Collapsing them would put the 256-cap hazard back by another route.

`file` adds one file's document symbols to the search. That is the only route to **object-literal property keys** — RPC handler maps, route tables — which neither backend's project-wide index sees. Measured on 7.0.2 against a handler map:

| | `workspace/symbol "Handler"` | `documentSymbol` |
|---|---|---|
| hits | 1 (the `rpcHandlers` binding) | 10 (every key, incl. nested) |

Two tsgo LSP behaviours worth knowing, both encoded in `src/lsp-client.ts`:
- `workspace/symbol` returns `[]` until a project is loaded — you must `didOpen` a file first.
- The server issues `client/registerCapability` and **blocks** until the client replies.

## TSGo LSP hover, diagnostics, and code actions

The LSP tools are for editor-style semantic feedback, not text search:

- `ts_hover` asks `@effect/tsgo --lsp` for `textDocument/hover`. In Effect projects this can return the richer Effect Language Service presentation, including expanded `Success`, `Failure`, and `Requirements` blocks.
- `ts_layer_hover` is a focused wrapper over the same hover response. It flags Layer hovers and extracts Mermaid graph links when `@effect/tsgo` includes them.
- `ts_effect_diagnostics` runs `@effect/tsgo diagnostics --format json` against either the configured project or one file. It returns structured rule names, codes, severities, ranges, messages, and summary counts. On plain TypeScript TSGo projects, it returns `unavailable: true` with a reason instead of pretending Effect diagnostics ran.
- `ts_code_actions` asks `textDocument/codeAction` for quick fixes and refactors. Diagnostic quick fixes need diagnostics in the request context; refactors can be listed from a selected symbol/range without diagnostics.

Use these before grepping TypeScript when the question is about a symbol's editor hover, Effect channels, Effect diagnostics, available quick fixes, or Layer composition. Use `rg`/`grep` for docs/config/non-TypeScript assets and broad syntactic discovery where no symbol identity is involved.

## Install model: skills + MCP config, nothing else

`setup` writes two kinds of thing into a project — SKILL.md files, and an MCP
server entry in each agent's own config. It does not copy this package
anywhere. There is no plugin directory, no second `node_modules` to install,
and no vendored copy to drift out of sync with the one npm manages.

| Provider | Skills directory | MCP config |
|---|---|---|
| Claude Code | `.claude/skills/` | `.mcp.json` |
| Cursor | `.cursor/skills/`, or rides along with `.claude`/`.agents` | `.cursor/mcp.json` |
| OpenCode | `.claude/skills/` or `.agents/skills/` (whichever is already written) | `opencode.json(c)` |
| Codex | `.agents/skills/` | `.codex/config.toml` |
| Copilot | `.agents/skills/` | `.vscode/mcp.json` |
| Antigravity | `.agents/skills/` | `~/.gemini/antigravity/mcp_config.json` |
| Gemini CLI | `.agents/skills/` | — none; register manually |

Cursor and OpenCode each read several of these locations, so
`computeSkillTargets()` computes a minimal covering set rather than writing
per-agent. Selecting all seven providers writes **two** directories, not four —
otherwise the flexible agents would discover every skill more than once.

### Which copy of the server gets registered

`resolveServerTarget()` prefers a copy resolvable *from the project* — a real
dependency — and writes a **project-relative** path for it. That matters
because `.mcp.json`, `.cursor/mcp.json` and `opencode.json` normally get
committed: an absolute path resolves only on the machine that ran `setup`.
Antigravity's config lives in `$HOME` and cannot use a relative path for either
the server or the project root, so it alone gets absolutes.

Falling back to the running copy is fine for a global install or a dev
checkout, but an npx-cache path is flagged: npm garbage-collects that
directory, which would leave the entry pointing at nothing.

The literal `node_modules/typegraph-mcp` is preferred over what
`require.resolve` returns, because that is a realpath — under pnpm it is
`node_modules/.pnpm/typegraph-mcp@<version>/node_modules/typegraph-mcp`, a
version-pinned path that dies on the next upgrade. The symlink is the stable
name.

### Public entry points, no flag

```
typegraph-mcp setup|remove|check  the installer
typegraph-mcp                     serves when stdio is piped; prints usage at a TTY
typegraph                         compatibility alias for typegraph-mcp
typegraph-mcp-server              direct stdio server
```

An MCP entry never has to name a subcommand or a path inside the package —
`npx typegraph-mcp` with stdio piped is a complete server command. The installer
still writes `node <path>` instead, which skips npx's resolver on every server
start and cannot reach the network for a version you did not ask for; both work.

`typegraph-mcp` with no arguments decides by looking at stdin. A client always
arrives with stdio piped; a person at a terminal does not, and gets usage rather
than a process that appears to hang. The public bin is a tiny `dist/cli.cjs`
trampoline in the published package (`src/cli.cjs` in source checkout mode)
that validates Node before importing the implementation; `src/cli.ts`
therefore imports nothing but `node:path` at the top level and loads each branch
dynamically — @clack/prompts writes to stdout, and stdout carries nothing but
JSON-RPC once a client is connected. `tests/cli-dispatch-test.ts` asserts that
statically.

## Installer invariants

1. **`${CLAUDE_PLUGIN_ROOT}` was never expanded** for non-Claude agents. Only Claude Code expands it, and only for plugin-discovered skills — so `.agents/skills/` copies shipped it literally. With no plugin directory at all, nothing would expand it anywhere. Replaced by an install-time `__TYPEGRAPH_ROOT__` absolute-path substitution.

2. **Baked interpreter paths rot, but stale `node` is worse.** `process.execPath` under nvm bakes `~/.nvm/versions/node/v24.1.0/bin/node`, which vanishes on the next Node upgrade — silently preventing the MCP server from starting. `resolveInterpreter()` prefers a compatible `node` on PATH, but falls back to the current executable rather than writing a command that resolves to Node <22.18. `typegraph-mcp check` detects both dead paths and too-old interpreters.

3. **Global MCP entries were never removed.** `remove` deregistered project configs but left Antigravity's `~/.gemini/antigravity/mcp_config.json` entry behind, pointing at an uninstalled server.

## Commands

Use Node 24 for development. The repo carries both `.nvmrc` and `.node-version`
with `24.11.0`; `engines.node` remains `>=22.18` because 22.18 is the runtime
floor for native TypeScript type stripping. This package uses npm, so there is
no pnpm-specific Node-version control involved.

```bash
npm test           # routing, installer, and live-invalidation tests
npm run check      # health check: binary, version skew, stale interpreters
npm run typecheck  # tsc --noEmit (TypeScript 7)

# end-to-end against a real project
node tests/server-smoke.ts <projectRoot>
node tests/effect-lsp-smoke.ts <effectProjectRoot> [tsconfig]
node tests/refresh-bench.ts <projectRoot>
```

## Release/versioning

Package versions are bumped in the repo, not by CI. Before pushing a release to
`main`, update `package.json` and `package-lock.json` with the intended version
(`npm version patch --no-git-tag-version`, or the equivalent minor/major bump).
The GitHub Actions publish job validates, builds, publishes exactly the committed
version, creates the matching `vX.Y.Z` tag, and syncs `dev` to `main`.

Verified on a 1506-file fixture against `@effect/tsgo` 0.32.1 / `typescript` 7.0.2:

```
boot + snapshot: 74.9ms      binary: @effect/tsgo
index build:    177.3ms  ->  31502 entries, 10502 unique (0.118 ms/file)
checker:        makeWidget0 : (id: string) => Widget0
```

The 3× gap between raw entries and unique symbols is barrel re-export duplication, collapsed exactly by deduping on `symbol.id`.

## Install

```bash
npm install --save-dev typegraph-mcp   # so configs can be relative, and committed
npx typegraph-mcp setup                 # detects agents, installs MCP + skills
npx typegraph-mcp check                 # verify
npx typegraph-mcp remove                # full round-trip undo
```

`setup` works without the first line — it just writes absolute paths and says so.

`check` verifies the three things that otherwise fail silently: the tsgo binary
resolves, the client/binary versions still agree, and every installed config's
interpreter is present/new enough while the server path still exists on disk.

`opencode.jsonc` is handled properly — `src/jsonc.ts` is a string-aware comment
stripper, so a config containing `https://example.com//docs` survives
registration intact. The inherited installer would have hit `JSON.parse`, warned,
and silently skipped registering the server.

### TypeScript runtime and tsconfig

The semantic backend always speaks the TypeScript 7 `--api` protocol. It first
tries the Effect-patched `@effect/tsgo` binary for projects that already carry a
native TypeScript 7 package (`typescript@>=7` or `@typescript/native`). If the
target project is still on TypeScript 5.x, it falls back to this package's
bundled `typescript@7.0.2` binary and analyzes the project in compatibility
mode. That lets TypeScript 5 projects use the tool without changing their own
compiler dependency, while keeping the MCP client and TSGo binary on the same
wire protocol.

TSGo also needs an explicit tsconfig project. The installer writes
`TYPEGRAPH_TSCONFIG=./tsconfig.json` by default; set `TYPEGRAPH_TSCONFIG` before
running setup if the project uses a different root config.

## Build and runtime model

There is no bundler and no `tsx`. Source checkout commands use `.cjs`
trampolines (`src/cli.cjs`, `src/server.cjs`, `src/check.cjs`) that validate
Node before importing the `.ts` implementations, so old Node prints a clear
version error instead of dying on `ERR_UNKNOWN_FILE_EXTENSION`.

The npm package publishes compiled `dist/` entrypoints. That is required because
Node's native TypeScript type stripping deliberately refuses to strip `.ts`
files under `node_modules`; a devDependency install must run `.js`, even on
Node 24.

The source-mode cost is staying inside **erasable syntax**: no parameter
properties, no enums, no namespaces, and `.ts` import specifiers throughout
(strip-only mode does not remap `.js` → `.ts`). The published `dist/` build
rewrites relative `.ts` imports to `.js` before packing.

This avoids an install-time failure mode: `tsx` is not needed at runtime, and
the package is designed for installs that omit dev dependencies.

## Live invalidation

`fs.watch` feeds a dirty set that is applied lazily before each query, so a
burst of edits collapses into one refresh. Measured on the 1506-file fixture
(`tests/refresh-bench.ts`):

| | |
|---|---|
| full re-snapshot | 3.5ms |
| `applyChanges({changed:[1]})` | 1.3ms |
| `reindex(1 file)` | 1.4ms |
| full index rebuild | 115.7ms |

The snapshot was never the expensive part — tsgo keeps the program warm. The
cost is the export index, at ~83× a targeted re-index. That is why `Invalidator`
tracks *which* files changed rather than a dirty boolean: `updateSnapshot`
reports back per-project `changedFiles`, so re-indexing is surgical rather than
inferred.

## Not yet done

- Gemini CLI has no MCP registration path (`mcp: { kind: "none" }`)
- The oxc module graph has its own `startWatcher`, currently unused by the server — graph tools rebuild per session
- `fs.watch({recursive:true})` is fine on macOS/Windows and Linux ≥20, but unwatched failures degrade silently to "snapshot as of last explicit refresh"
