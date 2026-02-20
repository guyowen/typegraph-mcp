# typegraph-mcp

Give your AI coding agent the same TypeScript understanding your IDE has.

14 semantic navigation tools — go-to-definition, find-references, type info, dependency graphs, cycle detection, impact analysis — delivered via the [Model Context Protocol](https://modelcontextprotocol.io/) so any MCP-compatible agent can use them.

## The problem

AI coding agents navigate TypeScript blind. They `grep` for a symbol name and get string matches instead of real references. They read entire files to find a type that's re-exported through three barrel files. They can't tell you what depends on what, or whether your refactor will break something two packages away.

Every wrong turn burns context tokens and degrades the agent's output.

## The difference

Measured on a real monorepo — tracing a call chain from an API handler to its implementation:

| | grep | typegraph-mcp |
|---|---|---|
| **Tokens consumed** | ~113,000 | 1,006 |
| **Files touched** | 47 | 3 |
| **False positives** | dozens of string matches | 0 |

**99% context reduction.** The agent gets precise answers in milliseconds instead of noisy guesses.

### Before: grep-based navigation

```
Agent: I need to find where createUser is implemented.
  → grep "createUser" across project
  → 47 results: test files, comments, variable names, string literals, actual definitions
  → reads 6 files trying to follow the chain
  → burns ~113,000 tokens, still not sure it found the right implementation
```

### After: typegraph-mcp

```
Agent: ts_trace_chain({ file: "src/handlers.ts", symbol: "createUser" })
  → 3-hop chain: handlers.ts → UserService.ts → UserRepository.ts
  → each hop shows the exact line with a code preview
  → 1,006 tokens, done
```

## Quick start

### Option A: CLI setup (recommended)

```bash
# Clone and install
git clone https://github.com/ojonesjr/typegraph-mcp.git ~/typegraph-mcp
cd ~/typegraph-mcp && pnpm install

# Run setup from your project root
cd /path/to/your-ts-project
npx tsx ~/typegraph-mcp/cli.ts setup
```

The `setup` command does everything:
1. Creates/updates `.claude/mcp.json` with the correct server path
2. Appends agent instructions to `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, or `.github/copilot-instructions.md` (if they exist)
3. Runs health checks and smoke tests to verify everything works

Use `--yes` to skip confirmation prompts.

### Option B: Manual setup

If you prefer to configure things yourself:

1. Add to `.claude/mcp.json` in your project (or `~/.claude/mcp.json` for global):

```json
{
  "mcpServers": {
    "typegraph": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/typegraph-mcp/server.ts"],
      "env": {
        "TYPEGRAPH_PROJECT_ROOT": ".",
        "TYPEGRAPH_TSCONFIG": "./tsconfig.json"
      }
    }
  }
}
```

2. Verify with `npx tsx ~/typegraph-mcp/cli.ts check` and `npx tsx ~/typegraph-mcp/cli.ts test`.

`TYPEGRAPH_PROJECT_ROOT` resolves relative to the agent's working directory. Use `"."` for project-local config. The `args` path to `server.ts` must be absolute.

### Restart your agent session

First query takes ~2s (tsserver warmup). Subsequent queries: 1–60ms.

## Requirements

- **Node.js** >= 18
- **TypeScript** >= 5.0 in the target project (`node_modules`)
- **pnpm** for installing typegraph-mcp dependencies

## CLI

```
Usage: typegraph-mcp <command> [options]

Commands:
  setup   Set up typegraph-mcp in the current project
  check   Run health checks (12 checks)
  test    Run smoke tests (all 14 tools)
  start   Start the MCP server (stdin/stdout)

Options:
  --yes   Skip confirmation prompts (accept all defaults)
  --help  Show help
```

Run any command with:

```bash
npx tsx ~/typegraph-mcp/cli.ts <command>
```

### `setup`

One-command project setup. Detects whether typegraph-mcp is embedded inside the project (e.g. `tools/typegraph-mcp/`) or external, and configures paths accordingly. Scans for existing agent instruction files and appends the `ts_*` tools snippet if not already present.

### `check`

Runs 12 health checks: Node.js version, TypeScript installation, tsconfig validity, MCP registration, dependency versions, etc. Every failing check shows a `Fix:` instruction.

### `test`

Exercises all 14 tools against the target project — graph build, dependency tree, cycle detection, go-to-definition, references, type info, and more. Dynamically discovers a file in the project to test against.

### `start`

Starts the MCP server on stdin/stdout. This is what the MCP client calls — you typically don't run this directly.

## Tools

### Semantic point queries (tsserver)

These tools understand your types, resolve through imports and barrel files, and return real code — not string matches.

#### `ts_find_symbol`
Find a symbol's location in a file by name.

```
{ file: "src/services/Auth.ts", symbol: "validateToken" }
→ { file, line, column, kind, preview }
```

#### `ts_definition`
Go to definition. Resolves through imports, re-exports, barrel files, interfaces, and generics.

```
{ file: "src/handlers.ts", symbol: "UserService" }
→ { definitions: [{ file, line, column, preview }] }
```

#### `ts_references`
Find all semantic references to a symbol (not string matches).

```
{ file: "src/services/Auth.ts", symbol: "validateToken" }
→ { references: [{ file, line, column, preview, isDefinition }], count }
```

#### `ts_type_info`
Get the TypeScript type and documentation — the same info you see hovering in VS Code.

```
{ file: "src/handlers.ts", symbol: "userService" }
→ { type: "const userService: { readonly getUser: ...", documentation: "..." }
```

#### `ts_navigate_to`
Search for a symbol across the entire project without knowing which file it's in.

```
{ symbol: "validateToken", maxResults: 10 }
→ { results: [{ file, line, column, kind, containerName }], count }
```

#### `ts_trace_chain`
Follow go-to-definition hops automatically, building a call chain from entry point to implementation.

```
{ file: "src/handlers.ts", symbol: "createUser", maxHops: 5 }
→ { chain: [{ file, line, column, preview }, ...], hops: 3 }
```

#### `ts_blast_radius`
Analyze the impact of changing a symbol — all usage sites and affected files.

```
{ file: "src/services/Auth.ts", symbol: "validateToken" }
→ { directCallers: 12, filesAffected: ["src/handlers.ts", ...], callers: [...] }
```

#### `ts_module_exports`
List all exports from a module with their resolved types.

```
{ file: "src/services/Auth.ts" }
→ { exports: [{ symbol, kind, line, type }], count }
```

### Structural graph queries (oxc-parser + oxc-resolver)

These tools operate on the full import graph, built in ~100ms and kept current via `fs.watch`.

#### `ts_dependency_tree`
Transitive dependency tree of a file — what it depends on.

```
{ file: "src/handlers.ts", depth: 3, includeTypeOnly: false }
→ { root, nodes: 42, files: [...] }
```

#### `ts_dependents`
All files that depend on a given file, grouped by package.

```
{ file: "src/schemas/ids.ts" }
→ { nodes: 155, directCount: 31, byPackage: { "@my/core": [...] } }
```

#### `ts_import_cycles`
Detect circular import dependencies (strongly connected components).

```
{ file: "src/services/Auth.ts" }  // optional filter
→ { count: 1, cycles: [["src/a.ts", "src/b.ts"]] }
```

#### `ts_shortest_path`
Shortest import path between two files.

```
{ from: "src/handlers.ts", to: "src/schemas/ids.ts" }
→ { path: ["handlers.ts", "schemas/index.ts", "schemas/ids.ts"], hops: 2 }
```

#### `ts_subgraph`
Extract the neighborhood around seed files — imports, dependents, or both.

```
{ files: ["src/services/Auth.ts"], depth: 1, direction: "both" }
→ { nodes: [...], edges: [{ from, to, specifiers }], stats: { nodeCount, edgeCount } }
```

#### `ts_module_boundary`
Analyze coupling of a module: incoming/outgoing edges, shared dependencies, isolation score.

```
{ files: ["src/schemas/ids.ts", "src/schemas/queue.ts"] }
→ { internalEdges: 8, incomingEdges: [...], outgoingEdges: [...], isolationScore: 0.058 }
```

## Architecture

```
AI Agent ─── stdin/stdout ─── MCP Server ─┬── tsserver (child process)
              MCP protocol                │     type-aware point queries
                                          └── module-graph (in-process)
                                                oxc-parser + oxc-resolver
                                                structural graph queries
```

Two subsystems start concurrently:

1. **tsserver** — child process for semantic queries. Communicates via pipes using tsserver's JSON protocol. Auto-restarts on crash (up to 3 times) and re-opens tracked files.

2. **Module graph** — in-process import graph built with [oxc-parser](https://github.com/nicolo-ribaudo/oxc-parser) (fast NAPI parser, no AST walking) and [oxc-resolver](https://github.com/nicolo-ribaudo/oxc-resolver) (tsconfig-aware resolution). Incrementally updated via `fs.watch`.

### Monorepo support

Works out of the box with TypeScript project references:

- Resolves through `composite` project references and declaration maps
- Maps `dist/` paths back to source (handles `outDir: "dist"` / `rootDir: "src"`)
- `extensionAlias` for NodeNext `.js` → `.ts` import mapping
- Cross-package barrel re-export resolution

Point `TYPEGRAPH_TSCONFIG` at your root `tsconfig.json` that includes all project references.

### ESLint configuration

If typegraph-mcp is embedded inside the project (e.g. `tools/typegraph-mcp/`) and the project uses `typescript-eslint`, add to your ESLint `ignores`:

```javascript
ignores: [
  "tools/**",
  ".typegraph-test/**",
]
```

Not needed when typegraph-mcp lives outside the project tree.

### Agent instructions snippet

Add this to your agent instructions file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, etc.) so the agent uses TypeGraph instead of grep:

```markdown
## TypeScript Navigation (typegraph-mcp)

Use the `ts_*` MCP tools instead of grep/glob for navigating TypeScript code. They resolve through barrel files, re-exports, and project references — returning precise results, not string matches.

- **Point queries** (tsserver): `ts_find_symbol`, `ts_definition`, `ts_references`, `ts_type_info`, `ts_navigate_to`, `ts_trace_chain`, `ts_blast_radius`, `ts_module_exports`
- **Graph queries** (import graph): `ts_dependency_tree`, `ts_dependents`, `ts_import_cycles`, `ts_shortest_path`, `ts_subgraph`, `ts_module_boundary`
```

## Troubleshooting

Run the health check first — it catches most issues:

```bash
npx tsx ~/typegraph-mcp/cli.ts check
```

| Symptom | Likely cause | Fix |
|---|---|---|
| Server won't start | Dependencies missing | `cd /path/to/typegraph-mcp && pnpm install` |
| "TypeScript not found" | Target project missing TS | Add `typescript` to devDependencies |
| Tools return empty results | tsconfig misconfigured | Check `TYPEGRAPH_TSCONFIG` points to the right file |
| MCP registration not found | Wrong path in config | Verify the `args` path to `server.ts` is absolute |

## Benchmarking

Run the benchmark suite to measure typegraph-mcp vs grep on your codebase:

```bash
npx tsx benchmark.ts

# Or against a different project:
TYPEGRAPH_PROJECT_ROOT=/path/to/project npx tsx benchmark.ts
```

The benchmark is fully dynamic — it discovers test scenarios from the module graph rather than using hardcoded symbols, so it works on any TypeScript project.

### What it measures

| Benchmark | What it tests |
|---|---|
| **Token comparison** | Context tokens consumed: grep (read all matching files) vs typegraph (structured JSON response) |
| **Latency** | Per-tool timing (p50, p95, avg) across 5 runs for all 14 tools |
| **Accuracy** | Qualitative comparison across 5 scenarios (barrel resolution, disambiguation, type-only imports, impact analysis, cycle detection) |

### Dynamic scenario discovery

Each scenario is discovered from the project's import graph — no hardcoded symbols or paths:

| Discovery function | What it finds |
|---|---|
| `findBarrelChain` | An `index.ts` that re-exports named specifiers from a non-index file |
| `findHighFanoutSymbol` | The most-imported symbol by frequency across all edges |
| `findPrefixSymbol` | A symbol whose name is a prefix of others (e.g. `Auth` vs `AuthLive`) |
| `findMixedImportFile` | A file with both `import type` and runtime imports |
| `findMostDependedFile` | The file with the most reverse edges (most depended-on) |
| `findChainFile` | A file with a traceable multi-hop import chain |
| `findLatencyTestFile` | A medium-sized service/handler file suitable for latency testing |

Scenarios that can't be found in the target codebase are gracefully skipped.

## Known limitations

- **Object literal property keys** (e.g., RPC handler names) are not indexed by tsserver's `navto`. Use `ts_find_symbol` with a specific file, or pass the `file` hint to `ts_navigate_to`.
- **First query latency** — ~2s as tsserver loads the project. Subsequent queries are 1–60ms.
- **Memory** — tsserver holds the project in memory. For very large monorepos (1000+ files), expect ~200–500MB RSS.

## License

MIT
