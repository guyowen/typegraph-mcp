# ts-nav-mcp

MCP server that gives AI coding agents type-aware TypeScript codebase navigation — go-to-definition, find-references, type info, dependency graphs, cycle detection, and more — powered by `tsserver` and `oxc-parser`.

## Why

AI agents navigating TypeScript codebases typically rely on `grep` and file reads, which produce noisy results and can't resolve types, barrel re-exports, or cross-package imports. This MCP server provides **semantic** navigation: it understands your types, follows imports through barrel files to source (not `.d.ts`), and returns only real code references (not string matches).

Measured against a real monorepo: **99% context token reduction** compared to grep-based navigation (1,006 vs ~113,000 tokens for the same call-chain trace).

## Requirements

- **Node.js** >= 18
- **TypeScript** >= 5.0 installed in the target project (resolved from `node_modules`)
- **tsx** (installed globally or via `npx`)

## Setup

### 1. Clone or copy to any location

```bash
git clone <this-repo> ~/tools/ts-nav-mcp
cd ~/tools/ts-nav-mcp
npm install
```

### 2. Register with your AI agent

#### Claude Code

Add to `.claude/mcp.json` in your project root (or `~/.claude/mcp.json` for global):

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

#### Other MCP-compatible agents

Any agent that supports the [Model Context Protocol](https://modelcontextprotocol.io/) can use this server. The server communicates over stdin/stdout using the standard MCP protocol. Configure your agent to spawn:

```bash
npx tsx /path/to/ts-nav-mcp/server.ts
```

With environment variables:
- `TS_NAV_PROJECT_ROOT` — absolute or relative path to the project root (default: cwd)
- `TS_NAV_TSCONFIG` — path to tsconfig.json relative to project root (default: `./tsconfig.json`)

### 3. Restart your agent

The MCP server starts automatically when your agent session begins. First query will take ~2s (tsserver warm-up), subsequent queries are typically 1-60ms.

## Tools

### `ts_find_symbol`
Find a symbol's location in a file by name. Entry point for navigating without exact line/column coordinates.

```
Input:  { file: "src/services/Auth.ts", symbol: "validateToken" }
Output: { file, line, column, kind, preview }
```

### `ts_definition`
Go to definition. Resolves through imports, re-exports, barrel files, interfaces, and generics. Accepts either `line+column` or `symbol` name.

```
Input:  { file: "src/handlers.ts", symbol: "UserService" }
   or:  { file: "src/handlers.ts", line: 42, column: 3 }
Output: { definitions: [{ file, line, column, preview }] }
```

### `ts_references`
Find all semantic references to a symbol (not string matches). Returns only real code usage.

```
Input:  { file: "src/services/Auth.ts", symbol: "validateToken" }
Output: { references: [{ file, line, column, preview, isDefinition }], count }
```

### `ts_type_info`
Get the TypeScript type and documentation for a symbol — the same info you see when hovering in VS Code.

```
Input:  { file: "src/handlers.ts", symbol: "userService" }
Output: { type: "const userService: { readonly getUser: ...", documentation: "...", kind: "const" }
```

### `ts_navigate_to`
Search for a symbol across the entire project without knowing which file it's in. Optionally provide a `file` hint to also search that file's navbar (useful for object literal property keys that `navto` doesn't index).

```
Input:  { symbol: "validateToken", maxResults: 10 }
Output: { results: [{ file, line, column, kind, containerName, matchKind }], count }
```

### `ts_trace_chain`
Automatically follow go-to-definition hops from a symbol, building a call chain from entry point to implementation. Stops at self-references, `node_modules`, or max hops.

```
Input:  { file: "src/handlers.ts", symbol: "createUser", maxHops: 5 }
Output: { chain: [{ file, line, column, preview }, ...], hops: 3 }
```

### `ts_blast_radius`
Analyze the impact of changing a symbol. Finds all references, filters to usage sites (excludes definition), and reports affected files.

```
Input:  { file: "src/services/Auth.ts", symbol: "validateToken" }
Output: { directCallers: 12, filesAffected: ["src/handlers.ts", ...], callers: [...] }
```

### `ts_module_exports`
List all exported symbols from a module with their resolved types. Gives an at-a-glance understanding of what a file provides.

```
Input:  { file: "src/services/Auth.ts" }
Output: { file, exports: [{ symbol, kind, line, type }], count }
```

### `ts_dependency_tree`
Get the transitive dependency tree (imports) of a file. Shows what a file depends on, directly and transitively.

```
Input:  { file: "src/handlers.ts", depth: 3, includeTypeOnly: false }
Output: { root, nodes: 42, files: ["src/utils.ts", ...] }
```

### `ts_dependents`
Find all files that depend on (import) a given file, directly and transitively. Groups results by package.

```
Input:  { file: "src/schemas/ids.ts" }
Output: { root, nodes: 155, directCount: 31, files: [...], byPackage: { "@my/core": [...], ... } }
```

### `ts_import_cycles`
Detect circular import dependencies in the project. Returns strongly connected components (cycles) in the import graph.

```
Input:  { file: "src/services/Auth.ts" }  // optional filter
Output: { count: 1, cycles: [["src/a.ts", "src/b.ts"]] }
```

### `ts_shortest_path`
Find the shortest import path between two files. Shows how one module reaches another through the import graph.

```
Input:  { from: "src/handlers.ts", to: "src/schemas/ids.ts" }
Output: { path: ["src/handlers.ts", "src/schemas/index.ts", "src/schemas/ids.ts"], hops: 2, chain: [...] }
```

### `ts_subgraph`
Extract a subgraph around seed files. Expands by depth hops in the specified direction (imports, dependents, or both).

```
Input:  { files: ["src/services/Auth.ts"], depth: 1, direction: "both" }
Output: { nodes: [...], edges: [{ from, to, specifiers, isTypeOnly }], stats: { nodeCount, edgeCount } }
```

### `ts_module_boundary`
Analyze the boundary of a set of files: incoming/outgoing edges, shared dependencies, and an isolation score. Useful for understanding module coupling before refactoring.

```
Input:  { files: ["src/schemas/ids.ts", "src/schemas/queue.ts", ...] }
Output: { internalEdges: 8, incomingEdges: [...], outgoingEdges: [...], sharedDependencies: [...], isolationScore: 0.058 }
```

## Architecture

```
AI Agent ─── stdin/stdout ─── MCP Server (server.ts) ─┬── pipe ─── tsserver (child)
              MCP protocol                             │              tsserver protocol
                                                       └── module-graph.ts (oxc-parser + oxc-resolver)
                                                                      import graph
```

The server is a single Node.js process with two subsystems initialized concurrently at startup:

1. **tsserver** — child process for type-aware point queries (definition, references, type info). Communicates over pipes using tsserver's Content-Length framed JSON protocol.
2. **Module graph** — in-process import graph built with `oxc-parser` (fast NAPI parser) and `oxc-resolver` (tsconfig-aware resolution). Provides structural queries (dependency trees, cycles, paths, boundaries). Incrementally updated via `fs.watch`.

Key design choices:
- **tsserver** (not `ts.createLanguageService()`) — handles declaration maps, project references, and cross-package navigation natively
- **oxc-parser + oxc-resolver** — ~100ms graph build for 400+ file monorepos. Uses `parseSync().module` convenience API (no AST walking). Resolves through tsconfig project references with `extensionAlias` for NodeNext `.js` → `.ts` mapping.
- **dist→source remapping** — automatically maps resolved `dist/` paths back to source `.ts` files in monorepos with `outDir: "dist"` / `rootDir: "src"` patterns
- **All paths relative** — tool inputs/outputs use project-relative paths; the server resolves to absolute paths internally
- **Navbar + navto fallback** — symbol search tries the file's AST (navbar) first, then falls back to project-wide search (navto). This covers object literal property keys that navto doesn't index
- **Graceful recovery** — auto-restarts tsserver on crash (up to 3 times), re-opens previously tracked files
- **Incremental graph updates** — `fs.watch` detects file changes and updates the import graph without full rebuild

## Known Limitations

- **Object literal property keys** (e.g., RPC handler names) are not indexed by tsserver's `navto` command. Use `ts_find_symbol` with a specific file, or pass the `file` hint to `ts_navigate_to`.
- **First query latency** — ~2s on first query as tsserver loads the project. Subsequent queries are fast (1-60ms warm).
- **Memory** — tsserver holds the project in memory. For very large monorepos (1000+ files), expect ~200-500MB RSS.

## Deploying to a New Project

### For an AI agent deploying this to a new TypeScript project:

1. **Verify TypeScript is installed** in the target project:
   ```bash
   ls node_modules/typescript/lib/tsserver.js
   ```
   If not present, the project needs `typescript` as a dev dependency.

2. **Verify a `tsconfig.json` exists** at the project root (or note its path for `TS_NAV_TSCONFIG`).

3. **Install the MCP server** dependencies (one-time):
   ```bash
   cd /path/to/ts-nav-mcp && npm install
   ```

4. **Register the MCP server** — add to `.claude/mcp.json` (or equivalent for your agent):
   ```json
   {
     "mcpServers": {
       "ts-nav": {
         "command": "npx",
         "args": ["tsx", "/absolute/path/to/ts-nav-mcp/server.ts"],
         "env": {
           "TS_NAV_PROJECT_ROOT": "/absolute/path/to/target/project",
           "TS_NAV_TSCONFIG": "./tsconfig.json"
         }
       }
     }
   }
   ```

5. **Restart the agent session** so it picks up the new MCP server.

6. **Test** by asking the agent to find a symbol or get type info on any file in the project.

### Monorepo support

For monorepos with TypeScript project references (`composite: true`), point `TS_NAV_TSCONFIG` at the root `tsconfig.json` that includes all project references. tsserver will automatically resolve cross-package imports through declaration maps.

## License

MIT
