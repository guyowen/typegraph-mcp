---
name: refactor-safety
description: Verify a refactor is safe before making changes. Trigger when renaming, moving, or restructuring TypeScript modules, extracting code into new modules, or changing interfaces and service definitions.
---

# Refactor Safety Check Workflow

Verify a refactor is safe before making changes by checking call chains, circular dependencies, and module boundaries.

## When to Activate

- User is about to rename, move, or restructure TypeScript modules
- User asks "is it safe to refactor X?"
- Before extracting code into a new module or package
- Before changing an interface or service definition
- Before applying Effect-specific mechanical rewrites or quick fixes

## Workflow

### Step 1: Symbol Overview
Call `ts_symbol_overview` on the symbol being refactored. This gives the definition, type, reference footprint, and grouped blast radius in one response.

For Effect values, call `ts_hover` to inspect the editor-style channel presentation. For Layer values, call `ts_layer_hover` to inspect the Layer graph before changing composition.

### Step 2: Trace the Chain
Call `ts_trace_chain` on the symbol being refactored to understand its full definition chain. This reveals all the layers of indirection the refactor needs to preserve.

### Step 3: Check for Cycles
Call `ts_import_cycles` filtered to the file being refactored. If the file participates in a cycle, the refactor must not break or worsen it.

### Step 4: Assess Boundaries
Call `ts_module_boundary` with the files involved in the refactor (source + destination). Check:
- **Incoming edges**: Other code that imports from these files (must be preserved)
- **Outgoing edges**: Dependencies these files need (must be available at new location)
- **Isolation score**: How self-contained the module is

### Step 5: Verify References
Use the references from `ts_symbol_overview`. Call `ts_references` separately only when you need the full raw list after the overview summary.

### Step 6: Use LSP Diagnostics / Actions For Effect Rewrites
When the refactor is motivated by Effect diagnostics or idioms, call `ts_effect_diagnostics` and then `ts_code_actions` on the diagnostic range. Treat offered quick fixes/refactors as evidence of the language service's intended rewrite, but still review the resulting behavior.

### Step 7: Report
Present a safety assessment:
1. **Definition chain** (what indirection exists)
2. **Cycle involvement** (any circular dependencies to be aware of)
3. **Boundary analysis** (incoming/outgoing edges, isolation)
4. **Call sites to update** (complete list from references)
5. **GO / CAUTION / STOP** recommendation

## Example

```
User: "I want to move AuthService from packages/core to apps/gateway"

1. ts_symbol_overview -> AuthService has 23 references across 15 files
2. ts_trace_chain -> AuthService defined in core, consumed via Layer in gateway
3. ts_import_cycles -> No cycles involving AuthService.ts
4. ts_module_boundary -> 12 incoming edges (other core modules import it), 3 outgoing

CAUTION: AuthService has 12 incoming edges within packages/core.
         Moving it to apps/gateway would break the core -> gateway dependency direction.
         Consider: keep the interface in core, move only the Live implementation.
```
