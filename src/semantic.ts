/**
 * The 7 point-query tools, implemented on the tsgo API.
 *
 * Two TSGo API shape details drive most of the code here:
 *
 *  - MCP callers speak line/column; the API speaks byte offsets. We convert
 *    locally against the file text rather than paying a round-trip.
 *  - The API returns NodeHandles. A handle carries
 *    `.path` for free, but needs `.resolve()` for a position — so we resolve in
 *    batches grouped by file.
 */
import fs from "node:fs";
import path from "node:path";
import { getTokenAtPosition } from "typescript/unstable/ast";
import type { ApiClient } from "./api-client.ts";

/** ast.SymbolFlags — only the ones we branch on. */
export const SymbolFlags = {
  Variable: 3,
  Property: 4,
  Enum: 256,
  Class: 32,
  Interface: 64,
  Function: 16,
  Method: 8192,
  ValueModule: 512,
  TypeAlias: 524288,
  Alias: 2097152,
} as const;

const TYPE_ONLY = SymbolFlags.Interface | SymbolFlags.TypeAlias;

export interface Loc {
  file: string;
  line: number;
  column: number;
  preview?: string;
}

export interface ReferenceHit extends Loc {
  isDefinition: boolean;
}

export interface TypeInfo {
  type: string | null;
  documentation: string | null;
  kind: string | null;
  name: string;
}

export interface ExportInfo {
  symbol: string;
  name: string;
  kind: string;
  line?: number;
  type: string;
  exportKind: "type" | "value";
  isTypeOnly: boolean;
  isNamespace: boolean;
  source: "local" | "re-export";
  from?: string;
  definedIn?: string;
  definedLine?: number;
  flags: number;
}

export interface ChainHop {
  file: string;
  line: number;
  column: number;
  symbol: string;
  preview: string;
}

export interface BlastRadius {
  symbol: string;
  totalReferences: number;
  filesAffected: number;
  byFile: Array<{ file: string; count: number; lines: number[] }>;
}

export class SemanticService {
  #textCache = new Map<string, { text: string; lineStarts: number[] }>();

  readonly api: ApiClient;

  constructor(api: ApiClient) {
    this.api = api;
  }

  // ─── text + position helpers ──────────────────────────────────────────────

  #canonicalPath(file: string): string {
    const absolute = path.isAbsolute(file) ? file : path.resolve(this.api.options.projectRoot, file);
    try {
      return fs.realpathSync.native(absolute);
    } catch {
      return absolute;
    }
  }

  #load(file: string): { text: string; lineStarts: number[] } {
    file = this.#canonicalPath(file);
    const cached = this.#textCache.get(file);
    if (cached) return cached;
    const text = fs.readFileSync(file, "utf-8");
    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
    }
    const entry = { text, lineStarts };
    this.#textCache.set(file, entry);
    return entry;
  }

  /** Drop cached text — call after any edit that invalidates the snapshot. */
  invalidate(file?: string): void {
    if (file) this.#textCache.delete(file);
    else this.#textCache.clear();
  }

  /** 1-based line and column, matching the MCP output contract. */
  offsetToLoc(file: string, offset: number): { line: number; column: number } {
    file = this.#canonicalPath(file);
    const { lineStarts } = this.#load(file);
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo]! + 1 };
  }

  locToOffset(file: string, line: number, column: number): number {
    file = this.#canonicalPath(file);
    const { lineStarts } = this.#load(file);
    const start = lineStarts[Math.max(0, line - 1)] ?? 0;
    return start + Math.max(0, column - 1);
  }

  preview(file: string, line: number): string {
    file = this.#canonicalPath(file);
    try {
      const { text, lineStarts } = this.#load(file);
      const start = lineStarts[line - 1];
      if (start === undefined) return "";
      const end = lineStarts[line] ?? text.length;
      return text.slice(start, end).trim();
    } catch {
      return "";
    }
  }

  #locFromOffset(file: string, offset: number): Loc {
    file = this.#canonicalPath(file);
    const { line, column } = this.offsetToLoc(file, offset);
    return { file, line, column, preview: this.preview(file, line) };
  }

  // ─── handle resolution ────────────────────────────────────────────────────

  /**
   * Resolve NodeHandles to locations, grouped by file so each source file is
   * fetched once regardless of how many handles point into it.
   */
  async #resolveHandles(handles: readonly any[]): Promise<Loc[]> {
    const byPath = new Map<string, any[]>();
    for (const h of handles) {
      const canonical = this.#canonicalPath(h.path);
      const list = byPath.get(canonical) ?? [];
      list.push(h);
      byPath.set(canonical, list);
    }

    const out: Loc[] = [];
    for (const [file, group] of byPath) {
      for (const handle of group) {
        const node = await handle.resolve().catch(() => undefined);
        if (!node) continue;
        const offset: number =
          typeof node.getStart === "function" ? node.getStart() : (node.pos ?? 0);
        try {
          out.push(this.#locFromOffset(file, offset));
        } catch {
          out.push({ file, line: 0, column: 0 });
        }
      }
    }
    return out;
  }

  async #nodeAt(file: string, offset: number): Promise<any | undefined> {
    const sf = await this.api.program.getSourceFile(file);
    if (!sf) return undefined;
    return getTokenAtPosition(sf as any, offset);
  }

  // ─── Tool 1: ts_find_symbol ───────────────────────────────────────────────

  /**
   * Locate a named symbol inside a file.
   *
   * Text search finds candidate offsets, but every candidate is confirmed
   * against the checker — so this is semantic, not a string match. Declaration
   * sites are preferred over usages.
   */
  async findSymbol(file: string, name: string): Promise<Loc | null> {
    const { text } = this.#load(file);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "g");

    let firstUsage: Loc | null = null;

    for (const match of text.matchAll(re)) {
      const offset = match.index;
      const symbol = await this.api.checker.getSymbolAtPosition(file, offset);
      if (!symbol || symbol.name !== name) continue;

      const loc = this.#locFromOffset(file, offset);
      firstUsage ??= loc;

      // Prefer a position that is itself a declaration in this file.
      const decls: readonly any[] = symbol.declarations ?? [];
      if (decls.some((d) => d.path === file)) return loc;
    }
    return firstUsage;
  }

  // ─── Tool 2: ts_definition ────────────────────────────────────────────────

  /**
   * Resolve through imports, re-exports and barrel files.
   *
   * The alias hop is explicit here rather than delegated. `getAliasedSymbol`
   * walks an import/re-export chain to its origin, which is what makes a
   * barrel-heavy codebase resolve to the real declaration instead of the
   * re-export statement.
   */
  async definition(file: string, offset: number): Promise<Loc[]> {
    let symbol = await this.api.checker.getSymbolAtPosition(file, offset);
    if (!symbol) return [];

    if ((symbol.flags & SymbolFlags.Alias) !== 0) {
      const aliased = await this.api.checker.getAliasedSymbol(symbol).catch(() => undefined);
      if (aliased) symbol = aliased;
    }

    const decls: readonly any[] = symbol.declarations ?? [];
    if (decls.length === 0) return [];
    return this.#resolveHandles(decls);
  }

  // ─── Tool 3: ts_references ────────────────────────────────────────────────

  async references(file: string, offset: number): Promise<ReferenceHit[]> {
    const node = await this.#nodeAt(file, offset);
    if (!node) return [];

    const entries = await this.api.checker.getReferencedSymbolsForNode(node, offset);
    const hits: ReferenceHit[] = [];

    for (const entry of entries) {
      const isAliasEntry = (entry.symbol?.flags & SymbolFlags.Alias) !== 0;
      const defLocs = await this.#resolveHandles([entry.definition]);
      const defKeys = new Set(defLocs.map((d) => `${d.file}:${d.line}:${d.column}`));

      for (const loc of await this.#resolveHandles(entry.references)) {
        hits.push({
          ...loc,
          // TSGo reports a barrel export specifier as the definition of an
          // alias symbol. For impact analysis that specifier is a usage of the
          // original export, not a declaration to filter away.
          isDefinition: !isAliasEntry && defKeys.has(`${loc.file}:${loc.line}:${loc.column}`),
        });
      }
    }
    return hits;
  }

  // ─── Tool 4: ts_type_info ─────────────────────────────────────────────────

  async typeInfo(file: string, offset: number): Promise<TypeInfo | null> {
    const symbol = await this.api.checker.getSymbolAtPosition(file, offset);
    if (!symbol) {
      // Fall back to the type at the position — covers expressions that have a
      // type but no symbol of their own.
      const type = await this.api.checker.getTypeAtPosition(file, offset).catch(() => undefined);
      if (!type) return null;
      return {
        type: await this.api.checker.typeToString(type),
        documentation: null,
        kind: null,
        name: "",
      };
    }
    return this.typeInfoForSymbol(symbol);
  }

  async typeInfoForSymbol(symbol: any): Promise<TypeInfo> {
    // Type-only symbols have no value type; getTypeOfSymbol yields `any` for
    // them, which is correct but useless. Use the declared type instead.
    const type =
      (symbol.flags & TYPE_ONLY) !== 0
        ? await this.api.checker.getDeclaredTypeOfSymbol(symbol)
        : await this.api.checker.getTypeOfSymbol(symbol);

    const typeString = await this.api.checker.typeToString(type);

    // NOTE: the JS client names these differently from the wire methods
    // ("getDocumentationComment" / "getJsDocTags" on the Go side), and the
    // comment comes back as a plain string rather than a parts array.
    const docs: string = await this.api.checker
      .getDocumentationCommentOfSymbol(symbol)
      .catch(() => "");
    const tags: readonly any[] = await this.api.checker
      .getJsDocTagsOfSymbol(symbol)
      .catch(() => []);

    const documentation = [
      docs ?? "",
      tags.map((t: any) => `@${t.name}${t.text ? ` ${t.text}` : ""}`).join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      type: typeString,
      documentation: documentation || null,
      kind: describeFlags(symbol.flags),
      name: symbol.name,
    };
  }

  // ─── Tool 8: ts_module_exports ────────────────────────────────────────────

  async moduleExports(file: string): Promise<ExportInfo[]> {
    const requestedFile = this.#canonicalPath(file);
    const moduleSymbol = await this.api.moduleSymbol(file);
    if (!moduleSymbol) return [];
    const exports = await this.api.checker.getExportsOfModule(moduleSymbol);

    const out: ExportInfo[] = [];
    for (const sym of exports) {
      const aliased =
        (sym.flags & SymbolFlags.Alias) !== 0
          ? await this.api.checker.getAliasedSymbol(sym).catch(() => undefined)
          : undefined;
      const target = aliased ?? sym;
      const isTypeOnly = (target.flags & TYPE_ONLY) !== 0;
      const isNamespace =
        (target.flags & SymbolFlags.ValueModule) !== 0 || (sym.flags & SymbolFlags.ValueModule) !== 0;
      const exportLocs = await this.#resolveHandles(sym.declarations ?? []);
      const targetLocs = await this.#resolveHandles(target.declarations ?? []);
      const exportLoc = exportLocs[0] ?? targetLocs[0];
      const targetLoc = targetLocs[0] ?? exportLocs[0];
      const source =
        targetLoc && this.#canonicalPath(targetLoc.file) !== requestedFile ? "re-export" : "local";
      let typeString = "";
      try {
        const type =
          isTypeOnly
            ? await this.api.checker.getDeclaredTypeOfSymbol(target)
            : await this.api.checker.getTypeOfSymbol(target);
        typeString = await this.api.checker.typeToString(type);
      } catch {
        typeString = "unknown";
      }
      out.push({
        symbol: sym.name,
        name: sym.name,
        kind: describeFlags(target.flags),
        ...(exportLoc?.line !== undefined ? { line: exportLoc.line } : {}),
        type: typeString,
        exportKind: isTypeOnly ? "type" : "value",
        isTypeOnly,
        isNamespace,
        source,
        ...(source === "re-export" && targetLoc?.file ? { from: targetLoc.file } : {}),
        ...(targetLoc?.file ? { definedIn: targetLoc.file } : {}),
        ...(targetLoc?.line !== undefined ? { definedLine: targetLoc.line } : {}),
        flags: sym.flags,
      });
    }
    return out;
  }

  // ─── Tool 6: ts_trace_chain ───────────────────────────────────────────────

  /**
   * Follow definition hops from a starting position.
   *
   * Stops at maxHops, at a self-loop, or when a hop lands outside the project
   * (node_modules / lib.d.ts) — chasing into declaration files produces noise
   * rather than insight.
   */
  async traceChain(file: string, offset: number, maxHops = 5): Promise<ChainHop[]> {
    const hops: ChainHop[] = [];
    const seen = new Set<string>();
    let currentFile = file;
    let currentOffset = offset;

    for (let i = 0; i < maxHops; i++) {
      const symbol = await this.api.checker.getSymbolAtPosition(currentFile, currentOffset);
      const defs = await this.definition(currentFile, currentOffset);
      const next = defs[0];
      if (!next) break;

      const key = `${next.file}:${next.line}:${next.column}`;
      if (seen.has(key)) break;
      seen.add(key);

      if (next.file.includes("node_modules") || next.file.endsWith(".d.ts")) break;

      hops.push({
        file: next.file,
        line: next.line,
        column: next.column,
        symbol: symbol?.name ?? "",
        preview: next.preview ?? this.preview(next.file, next.line),
      });

      if (next.file === currentFile && next.line === this.offsetToLoc(currentFile, currentOffset).line) break;
      currentFile = next.file;
      currentOffset = this.locToOffset(next.file, next.line, next.column);
    }
    return hops;
  }

  // ─── Tool 7: ts_blast_radius ──────────────────────────────────────────────

  async blastRadius(file: string, offset: number): Promise<BlastRadius> {
    const symbol = await this.api.checker.getSymbolAtPosition(file, offset);
    const refs = await this.references(file, offset);

    const byFile = new Map<string, number[]>();
    for (const r of refs) {
      if (r.isDefinition) continue;
      const lines = byFile.get(r.file) ?? [];
      lines.push(r.line);
      byFile.set(r.file, lines);
    }

    const grouped = [...byFile.entries()]
      .map(([f, lines]) => ({ file: f, count: lines.length, lines: lines.sort((a, b) => a - b) }))
      .sort((a, b) => b.count - a.count);

    return {
      symbol: symbol?.name ?? "",
      totalReferences: grouped.reduce((n, g) => n + g.count, 0),
      filesAffected: grouped.length,
      byFile: grouped,
    };
  }
}

export function describeFlags(flags: number): string {
  if ((flags & SymbolFlags.Function) !== 0) return "function";
  if ((flags & SymbolFlags.Class) !== 0) return "class";
  if ((flags & SymbolFlags.Interface) !== 0) return "interface";
  if ((flags & SymbolFlags.Enum) !== 0) return "enum";
  if ((flags & SymbolFlags.Method) !== 0) return "method";
  if ((flags & SymbolFlags.TypeAlias) !== 0) return "type";
  if ((flags & SymbolFlags.Alias) !== 0) return "alias";
  if ((flags & SymbolFlags.ValueModule) !== 0) return "namespace";
  if ((flags & SymbolFlags.Property) !== 0) return "property";
  if ((flags & SymbolFlags.Variable) !== 0) return "variable";
  return "symbol";
}
