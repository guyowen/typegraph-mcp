#!/usr/bin/env npx tsx

import * as assert from "node:assert/strict";
import type { NavBarItem, QuickInfoResult } from "./tsserver-client.js";
import { selectQuickInfoSymbol } from "./smoke-test.js";

const syntheticCallback: NavBarItem = {
  text: "Alpine.data('table') callback",
  kind: "function",
  kindModifiers: "",
  spans: [
    {
      start: { line: 1, offset: 1 },
      end: { line: 1, offset: 21 },
    },
  ],
  childItems: [],
};

const typedConst: NavBarItem = {
  text: "booleanFilterFn",
  kind: "const",
  kindModifiers: "export",
  spans: [
    {
      start: { line: 2, offset: 1 },
      end: { line: 2, offset: 42 },
    },
  ],
  childItems: [],
};

const quickInfo: QuickInfoResult = {
  displayString: "const booleanFilterFn: FilterFn<any, any>",
  documentation: "",
  kind: "const",
  kindModifiers: "export",
  start: { line: 2, offset: 14 },
  end: { line: 2, offset: 29 },
};

const calls: Array<{ line: number; offset: number }> = [];
const client = {
  async quickinfo(_file: string, line: number, offset: number) {
    calls.push({ line, offset });
    return line === 2 && offset === 14 ? quickInfo : null;
  },
};

const selection = await selectQuickInfoSymbol(
  client,
  "src/main.ts",
  [syntheticCallback, typedConst],
  ["Alpine.data('table', () => ({}))", "export const booleanFilterFn = () => true"]
);

assert.ok(selection);
assert.equal(selection.symbol.text, "booleanFilterFn");
assert.deepEqual(selection.position, { line: 2, offset: 14 });
assert.equal(selection.info, quickInfo);
assert.deepEqual(calls, [{ line: 2, offset: 14 }]);

console.log("");
console.log("typegraph-mcp Smoke Test Selection Test");
console.log("=======================================");
console.log("  ✓ synthetic callbacks are skipped for typed declarations");
console.log("  ✓ quickinfo probes the declaration name rather than the span keyword");
