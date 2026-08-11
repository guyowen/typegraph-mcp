---
name: tool-selection
description: Select the right typegraph-mcp tool for TypeScript navigation. Trigger when finding definitions, references, types, exploring code structure, preparing refactors, or any task where you would otherwise use grep/glob for TypeScript symbols.
---

# TypeGraph Tool Selection Guide

Select the right typegraph-mcp tool for the task at hand. These tools provide type-aware TypeScript navigation — use them instead of grep/glob for any TypeScript codebase navigation.

## When to Activate

- Navigating TypeScript code (finding definitions, references, types)
- Exploring unfamiliar code or understanding how modules connect
- Preparing to refactor or modify TypeScript symbols
- Answering questions about code structure, dependencies, or impact
- Any task where you would otherwise use grep/glob to find TypeScript symbols

## Tool Selection Decision Tree

### "Where is X defined?"
Use **ts_definition** with the file + symbol name (or line+column). Resolves through barrel files, re-exports, and project references.

### "I don't know which file X is in"
Use **ts_navigate_to** with just the symbol name. Searches the entire project.

By default it searches **exported** symbols and returns exact, complete counts — safe to use for prevalence comparisons.

Three optional parameters, each covering a different blind spot:

- **`includeLocals: true`** also reaches non-exported locals and class members. This half is capped at 256 by the underlying language server; when the cap is hit the response sets `localsTruncated: true`. Treat `localHits` as a floor, never a total, and never compare two truncated counts. `exportHits` stays exact regardless — use it for any prevalence work.
- **`file: "src/handlers.ts"`** additionally searches that one file's document symbols. This is the *only* way to find **object-literal property keys** — RPC handler maps, route tables, config objects. Neither the export index nor `includeLocals` sees them: measured against a handler map, project-wide search returns one hit (the binding itself) while the file hint returns every key. Independent of `includeLocals`; use it whenever you suspect the symbol is a property key rather than a declaration.
- **`maxResults`** (default 10) trims the returned **list** only, best matches first. Every count in the response — `exportHits`, `localHits`, `navbarHits`, `totalHits` — describes the full result set, so a trimmed response is still safe to count from. `listTrimmed: true` tells you the list was shortened; it does **not** mean the counts are approximate. That distinction matters: `localsTruncated` invalidates a count, `listTrimmed` does not.

### "What is the type of X?"
Use **ts_type_info** — returns the same info as hovering in VS Code. Includes documentation.

### "What are all the exports of this file?"
Use **ts_module_exports** — lists all exported symbols with their resolved types.

If the file is a top-level barrel (`index.ts`, re-export hub), the result may be sparse or unhelpful for architecture discovery. For quick project insight, prefer composition modules such as entrypoints, routers, handler modules, service composition roots, or API modules that wire concrete behavior together.

### "Where is X used?"
Use **ts_references** for all semantic references. Unlike grep, this returns only real code references, not string matches in comments or unrelated variables.

### "What breaks if I change X?"
Use **ts_symbol_overview** first when you have one symbol. It returns the definition, hover type, reference counts, affected files, and blast radius in one call.

Use **ts_blast_radius** when you only need usage sites grouped by file, or when you are following up after `ts_symbol_overview`.

### "What symbols are inside this file?"
Use **ts_document_symbols**. This is the direct file-local view and the fastest way to inspect route tables, RPC handler maps, object-literal keys, and nested members in a known file.

### "How does the code get from A to B?"
Use **ts_trace_chain** — follows go-to-definition hops automatically, building a call chain. Stops at the bottom of the chain or at node_modules boundaries.

### "Is this export unused?"
Use **ts_dead_exports** on the module. It checks exported symbols against semantic non-definition references and returns possible dead exports.

### "Is the tool pointed at the right project?"
Use **ts_project_info** once at the start of a session when a result looks surprising. It reports the project root, tsconfig, backend, export-index size, and graph size.

### "What does this file import?"
Use **ts_dependency_tree** for the transitive import tree. Set `depth` to limit traversal.

### "What imports this file?"
Use **ts_dependents** — all files that depend on a given file, grouped by package. Shows both direct and transitive dependents.

### "Are there circular imports?"
Use **ts_import_cycles** — detects strongly connected components. Filter by file or package.

### "How does module A reach module B?"
Use **ts_shortest_path** — finds the shortest import path between two files in the module graph.

### "What's the neighborhood around these files?"
Use **ts_subgraph** — extracts nodes and edges around seed files, expanding by depth in any direction (imports, dependents, or both).

### "How coupled is this module?"
Use **ts_module_boundary** — analyzes incoming/outgoing edges, shared dependencies, and computes an isolation score.

## Key Principles

1. **Always prefer ts_* tools over grep/glob** for TypeScript navigation. They resolve through barrel files, re-exports, and project references.
2. **Start narrow, expand if needed.** Use ts_definition or ts_find_symbol first. Only use ts_navigate_to (project-wide search) when you don't know the file.
3. **Use composite helpers to avoid round-trip drift.** Impact analysis starts with ts_symbol_overview, then expands to ts_dependents or ts_module_boundary when the blast radius is broad. Refactor safety = ts_trace_chain + ts_import_cycles.
4. **Graph queries are instant** (~0.1ms). Point queries are fast (sub-millisecond to a few ms on tsgo). Don't hesitate to use them liberally.
5. **Startup is fast.** The tsgo backend loads a 1500-file project in well under a second — there is no multi-second warmup. Measured: ~53ms to open a project snapshot, ~190ms to build the export index, ~65ms for a cold LSP query.
6. **For fast architecture reads, start at composition modules, not barrels.** Barrels are useful for API shape, but entrypoints and composition roots tell you how the system is actually wired.

## Tool Reference

| Tool | Input | Best For |
|---|---|---|
| `ts_find_symbol` | file + symbol name | Locating a symbol when you know the file |
| `ts_definition` | file + symbol (or line+col) | Go-to-definition through any indirection |
| `ts_references` | file + symbol (or line+col) | All semantic references to a symbol |
| `ts_type_info` | file + symbol (or line+col) | Type signature and documentation |
| `ts_navigate_to` | symbol name (+ optional file) | Project-wide symbol search |
| `ts_trace_chain` | file + symbol + maxHops | Following a call chain to implementation |
| `ts_blast_radius` | file + symbol | Impact analysis for changes |
| `ts_module_exports` | file | Listing a module's public API |
| `ts_project_info` | none | Confirming project, tsconfig, backend, and graph/index sizes |
| `ts_document_symbols` | file (+ optional symbol) | File-local symbols and object-literal keys |
| `ts_symbol_overview` | file + symbol (or line+col) | One-call definition/type/references/blast summary |
| `ts_dead_exports` | file (+ maxResults) | Possible unused exports in one module |
| `ts_dependency_tree` | file (+ depth) | What a file depends on |
| `ts_dependents` | file (+ depth) | What depends on a file |
| `ts_import_cycles` | optional file/package filter | Circular dependency detection |
| `ts_shortest_path` | from file + to file | Import path between two files |
| `ts_subgraph` | seed files + depth + direction | Neighborhood extraction |
| `ts_module_boundary` | file list | Module coupling analysis |
