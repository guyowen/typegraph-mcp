---
name: impact-analysis
description: Analyze the impact of changing a TypeScript symbol by combining blast radius, dependents, and module boundary analysis. Trigger when asking what will break, assessing change risk, or before modifying widely-used symbols.
---

# Impact Analysis Workflow

Analyze the impact of changing a TypeScript symbol by combining blast radius, dependents, and module boundary analysis.

## When to Activate

- User asks "what will break if I change X?"
- User asks about the impact or blast radius of a change
- Before modifying a widely-used symbol, type, or interface
- Assessing risk of a refactor
- Assessing Effect channel, Layer, or diagnostic impact before changing Effect code

## Workflow

### Step 1: Symbol Overview
Call `ts_symbol_overview` with the file and symbol to get the definition, type, direct callers, affected files, and blast radius in one response.

If the symbol is an Effect or Layer value, also call `ts_hover` or `ts_layer_hover`. The TSGo LSP hover can expose expanded `Success`/`Failure`/`Requirements` channels and Layer graph information that raw reference counts do not show.

### Step 2: Assess Scope
- If **< 5 callers**: Low impact. Report the callers and you're done.
- If **5-20 callers**: Medium impact. Proceed to step 3 for package breakdown.
- If **> 20 callers**: High impact. Proceed to steps 3 and 4.

### Step 3: Package Breakdown
Call `ts_dependents` on the file to see the transitive impact grouped by package. This shows whether the change is contained to one package or crosses boundaries.

### Step 4: Module Boundary (for high-impact changes)
Call `ts_module_boundary` with the affected files to understand the coupling. A low isolation score means the change is tightly coupled to external code.

### Step 5: Diagnostics And Code Actions
For Effect-specific changes, call `ts_effect_diagnostics` on the file or project before and after the change. Use `ts_code_actions` on diagnostic ranges when the TSGo LSP offers a quick fix or refactor; prefer a proven LSP rewrite over hand-editing equivalent mechanical changes.

### Step 6: Report
Present findings as:
1. **Direct callers** (count + file list)
2. **Packages affected** (from dependents breakdown)
3. **Risk assessment** (low/medium/high based on caller count and cross-package spread)
4. **Suggested approach** (safe migration steps if high impact)

## Example

```
User: "What happens if I change the TenantId schema?"

1. ts_symbol_overview({ file: "packages/core/src/schemas/ids.ts", symbol: "TenantId" })
   -> 45 direct callers across 28 files, plus definition and hover type

2. ts_dependents({ file: "packages/core/src/schemas/ids.ts" })
   -> 158 transitive dependents across 4 packages

3. ts_module_boundary({ files: ["packages/core/src/schemas/ids.ts"] })
   -> isolation score: 0.058 (highly coupled)

Report: HIGH IMPACT. 45 direct usages across 28 files in 4 packages.
        The schemas module has very low isolation (0.058).
        Recommend: add new schema alongside old, migrate callers incrementally, then remove old.
```
