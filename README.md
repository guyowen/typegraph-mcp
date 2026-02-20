# ts-nav-mcp

Give your AI coding agent the same TypeScript understanding your IDE has.

14 semantic navigation tools — go-to-definition, find-references, type info, dependency graphs, cycle detection, impact analysis — delivered via the [Model Context Protocol](https://modelcontextprotocol.io/) so any MCP-compatible agent can use them.

## The problem

AI coding agents navigate TypeScript blind. They `grep` for a symbol name and get string matches instead of real references. They read entire files to find a type that's re-exported through three barrel files. They can't tell you what depends on what, or whether your refactor will break something two packages away.

Every wrong turn burns context tokens and degrades the agent's output.

## The difference

Measured on a real monorepo — tracing a call chain from an API handler to its implementation:

| | grep | ts-nav-mcp |
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

### After: ts-nav-mcp

```
Agent: ts_trace_chain({ file: "src/handlers.ts", symbol: "createUser" })
  → 3-hop chain: handlers.ts → UserService.ts → UserRepository.ts
  → each hop shows the exact line with a code preview
  → 1,006 tokens, done
```

## Quick start

### 1. Install

```bash
git clone https://github.com/AltClick/ts-nav-mcp.git ~/ts-nav-mcp
cd ~/ts-nav-mcp && pnpm install
```

### 2. Register

Add to `.claude/mcp.json` in your project (or `~/.claude/mcp.json` for global):

```json
{
  "mcpServers": {
    "ts-nav": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/ts-nav-mcp/server.ts"],
      "env": {
        "TS_NAV_PROJECT_ROOT": ".",
        "TS_NAV_TSCONFIG": "./tsconfig.json"
      }
    }
  }
}
```

`TS_NAV_PROJECT_ROOT` resolves relative to the agent's working directory. Use `"."` for project-local config. The `args` path to `server.ts` must be absolute.

### 3. Verify

```bash
# Configuration check — are all dependencies and settings correct?
npx tsx ~/ts-nav-mcp/check.ts

# Smoke test — do all 14 tools actually work on your codebase?
npx tsx ~/ts-nav-mcp/smoke-test.ts
```

`check.ts` validates configuration (12 checks: Node.js, TypeScript, tsconfig, MCP registration, dependencies, etc.). `smoke-test.ts` dynamically discovers a file in your project and exercises all 14 tools against it — graph build, dependency tree, cycle detection, go-to-definition, references, type info, and more. Both should pass.

### 4. Restart your agent session

First query takes ~2s (tsserver warmup). Subsequent queries: 1–60ms.

## Requirements

- **Node.js** >= 18
- **TypeScript** >= 5.0 in the target project (`node_modules`)
- **pnpm** for installing ts-nav-mcp dependencies

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

Point `TS_NAV_TSCONFIG` at your root `tsconfig.json` that includes all project references.

## Deploying to a new project

### For AI agents setting this up in a new TypeScript project:

1. **Verify prerequisites** in the target project:
   - `node_modules/typescript/lib/tsserver.js` exists (TypeScript installed)
   - `tsconfig.json` exists at the project root

2. **Install dependencies** (one-time):
   ```bash
   cd /path/to/ts-nav-mcp && pnpm install
   ```

3. **Register the MCP server** — add to `.claude/mcp.json`:
   ```json
   {
     "mcpServers": {
       "ts-nav": {
         "command": "npx",
         "args": ["tsx", "/absolute/path/to/ts-nav-mcp/server.ts"],
         "env": {
           "TS_NAV_PROJECT_ROOT": ".",
           "TS_NAV_TSCONFIG": "./tsconfig.json"
         }
       }
     }
   }
   ```

4. **Run the health check and smoke test**:
   ```bash
   npx tsx /path/to/ts-nav-mcp/check.ts
   npx tsx /path/to/ts-nav-mcp/smoke-test.ts
   ```
   `check.ts` verifies configuration. `smoke-test.ts` exercises all 14 tools against the project. Every failing check shows a `Fix:` instruction.

5. **Restart the agent session** and test with any `ts_*` tool.

### ESLint configuration

If ts-nav-mcp is embedded inside the project (e.g. `tools/ts-nav-mcp/`) and the project uses `typescript-eslint`, add to your ESLint `ignores`:

```javascript
ignores: [
  "tools/**",
  ".ts-nav-test/**",
]
```

Not needed when ts-nav-mcp lives outside the project tree.

### CLAUDE.md snippet

Add this to the project's `CLAUDE.md` so the agent knows to use ts-nav instead of grep:

```markdown
## TypeScript Navigation (ts-nav-mcp)

Use the `ts_*` MCP tools instead of grep/glob for navigating TypeScript code. They resolve through barrel files, re-exports, and project references — returning precise results, not string matches.

- **Point queries** (tsserver): `ts_find_symbol`, `ts_definition`, `ts_references`, `ts_type_info`, `ts_navigate_to`, `ts_trace_chain`, `ts_blast_radius`, `ts_module_exports`
- **Graph queries** (import graph): `ts_dependency_tree`, `ts_dependents`, `ts_import_cycles`, `ts_shortest_path`, `ts_subgraph`, `ts_module_boundary`
```

## Troubleshooting

Run the health check first — it catches most issues:

```bash
npx tsx /path/to/ts-nav-mcp/check.ts
```

| Symptom | Likely cause | Fix |
|---|---|---|
| Server won't start | Dependencies missing | `cd /path/to/ts-nav-mcp && pnpm install` |
| "TypeScript not found" | Target project missing TS | Add `typescript` to devDependencies |
| Tools return empty results | tsconfig misconfigured | Check `TS_NAV_TSCONFIG` points to the right file |
| MCP registration not found | Wrong path in config | Verify the `args` path to `server.ts` is absolute |

## Known limitations

- **Object literal property keys** (e.g., RPC handler names) are not indexed by tsserver's `navto`. Use `ts_find_symbol` with a specific file, or pass the `file` hint to `ts_navigate_to`.
- **First query latency** — ~2s as tsserver loads the project. Subsequent queries are 1–60ms.
- **Memory** — tsserver holds the project in memory. For very large monorepos (1000+ files), expect ~200–500MB RSS.

## License

MIT
