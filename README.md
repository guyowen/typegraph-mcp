# typegraph-mcp

<p align="center">
  <img src="./assets/hero.jpg" alt="typegraph-mcp — Semantic TypeScript understanding for AI agents" width="800">
</p>

Give your AI coding agent the same TypeScript understanding your IDE has.

14 semantic navigation tools — go-to-definition, find-references, type info, dependency graphs, cycle detection, impact analysis — delivered via the [Model Context Protocol](https://modelcontextprotocol.io/) so any MCP-compatible agent can use them.

## Before and after

```
grep "createUser" → 47 results across test files, comments, variable names
                    Agent reads 6 files, burns ~113,000 tokens, still guessing

ts_trace_chain({ file: "src/handlers.ts", symbol: "createUser" })
                  → handlers.ts → UserService.ts → UserRepository.ts
                    3 hops, 1,006 tokens, done
```

**99% context reduction** across all tested scenarios. [Full benchmarks](./BENCHMARKS.md).

## Quick start

### npm (recommended)

```bash
cd /path/to/your-ts-project
npx typegraph-mcp setup
```

The interactive setup:
1. Auto-detects your AI agents (Claude Code, Cursor, Codex CLI, Gemini CLI, GitHub Copilot)
2. Installs the plugin, registers the MCP server, copies workflow skills
3. Appends agent instructions to `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, etc.
4. Runs health checks and smoke tests to verify everything works

Use `--yes` to skip prompts and auto-select detected agents.

### Claude Code plugin

```bash
git clone https://github.com/guyowen/typegraph-mcp.git ~/typegraph-mcp
cd ~/typegraph-mcp && npm install
claude --plugin-dir ~/typegraph-mcp
```

Auto-configures MCP server, 5 workflow skills, `/typegraph:check` and `/typegraph:test` commands, and a SessionStart hook for dependency verification.

### Restart your agent session

First query takes ~2s (tsserver warmup). Subsequent queries: 1-60ms.

## Requirements

- **Node.js** >= 18
- **TypeScript** >= 5.0 in the target project
- **npm** for dependency installation

## Tools

### Semantic queries (tsserver)

| Tool | Description |
|---|---|
| `ts_find_symbol` | Find a symbol's location in a file by name |
| `ts_definition` | Go to definition — resolves through imports, re-exports, barrel files, generics |
| `ts_references` | Find all semantic references (not string matches) |
| `ts_type_info` | Get type and documentation — same as VS Code hover |
| `ts_navigate_to` | Search for a symbol across the entire project |
| `ts_trace_chain` | Follow definition hops automatically, building a call chain |
| `ts_blast_radius` | Analyze impact of changing a symbol — all usage sites and affected files |
| `ts_module_exports` | List all exports from a module with resolved types |

### Import graph queries (oxc-parser + oxc-resolver)

| Tool | Description |
|---|---|
| `ts_dependency_tree` | Transitive dependency tree of a file |
| `ts_dependents` | All files that depend on a given file, grouped by package |
| `ts_import_cycles` | Detect circular import dependencies |
| `ts_shortest_path` | Shortest import path between two files |
| `ts_subgraph` | Extract the neighborhood around seed files |
| `ts_module_boundary` | Analyze module coupling: incoming/outgoing edges, isolation score |

## CLI

```
typegraph-mcp <command> [options]

  setup    Install plugin into the current project
  remove   Uninstall from the current project
  check    Run 12 health checks
  test     Smoke test all 14 tools
  start    Start the MCP server (stdin/stdout)

  --yes    Skip prompts     --help    Show help
```

## Troubleshooting

Run the health check first — it catches most issues:

```bash
npx typegraph-mcp check
```

| Symptom | Fix |
|---|---|
| Server won't start | `cd plugins/typegraph-mcp && npm install` |
| "TypeScript not found" | Add `typescript` to devDependencies |
| Tools return empty results | Check `TYPEGRAPH_TSCONFIG` points to the right tsconfig |
| Build errors from plugins/ | Add `"plugins/**"` to tsconfig.json `exclude` array |

<details>
<summary><strong>Manual MCP configuration</strong></summary>

Add to `.claude/mcp.json` (or `~/.claude/mcp.json` for global):

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

`TYPEGRAPH_PROJECT_ROOT` resolves relative to the agent's working directory. The `args` path to `server.ts` must be absolute.

</details>

<details>
<summary><strong>How it works</strong></summary>

```
AI Agent ─── stdin/stdout ─── MCP Server ─┬── tsserver (child process)
              MCP protocol                │     type-aware point queries
                                          └── module-graph (in-process)
                                                oxc-parser + oxc-resolver
                                                structural graph queries
```

Two subsystems start concurrently:

1. **tsserver** — child process for semantic queries. Communicates via pipes using tsserver's JSON protocol. Auto-restarts on crash (up to 3 times).

2. **Module graph** — in-process import graph built with [oxc-parser](https://github.com/nicolo-ribaudo/oxc-parser) and [oxc-resolver](https://github.com/nicolo-ribaudo/oxc-resolver). Incrementally updated via `fs.watch`.

**Monorepo support** — resolves through `composite` project references, maps `dist/` back to source, handles `extensionAlias` for `.js` → `.ts` mapping, and follows cross-package barrel re-exports.

</details>

## Known limitations

- **Object literal property keys** (e.g., RPC handler names) are not indexed by tsserver's `navto`. Use `ts_find_symbol` with a specific file, or pass the `file` hint to `ts_navigate_to`.
- **First query latency** — ~2s as tsserver loads the project. Subsequent queries: 1-60ms.
- **Memory** — tsserver holds the project in memory. For very large monorepos (1000+ files), expect ~200-500MB RSS.
