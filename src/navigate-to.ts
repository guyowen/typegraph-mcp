/**
 * ts_navigate_to — hybrid resolver.
 *
 * Benchmarked both halves on typescript@7.0.2 (fixture: 1506 files, ~9000
 * exported symbols, 3000 non-exported locals):
 *
 *   export index (API)   exact, uncapped, ~0.13 ms/file to build, <1ms queries
 *                        BUT sees module exports only — 0 hits for
 *                        non-exported locals and class members.
 *
 *   workspace/symbol     sees every declaration incl. locals and methods,
 *   (LSP)                fuzzy subsequence matching
 *                        BUT hard-capped at 256 with no truncation flag.
 *                        At 1506 files EVERY non-trivial query saturated.
 *
 * The index is primary because the deep-survey skill uses ts_navigate_to as a
 * counting instrument (Phase 3b: navigate_to "Layer" / "Error" / "Test" to
 * distinguish project-wide conventions from one-offs). Under the 256 cap those
 * all saturate to the same number and the comparison silently yields a
 * confidently wrong architectural conclusion. Exact counts matter more there
 * than local-symbol coverage.
 *
 * The default result list is still export-index driven, then enriched with LSP
 * document-symbol coordinates for the displayed slice. `includeLocals` opts
 * into the broader LSP workspace-symbol search and reports truncation
 * separately from export counts.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiClient } from "./api-client.ts";
import { LspClient, RESULT_CAP } from "./lsp-client.ts";
import { describeFlags } from "./semantic.ts";

/**
 * Dedupe key for a (name, file) pair.
 *
 * NUL rather than a space or a colon because it cannot occur in either half —
 * not in an identifier, not in a POSIX path — so no pair of distinct symbols
 * can collide. Written as an escape on purpose: this was previously a literal
 * NUL byte in the source, invisible in every editor and diff.
 */
const keyOf = (name: string, file: string): string => `${name}\u0000${file}`;

export interface IndexEntry {
  name: string;
  file: string;
  /** ast.SymbolFlags bitfield */
  flags: number;
  /** Dedupe key for repeated sightings of the same exported symbol. */
  id: number;
}

export interface NavigateHit {
  name: string;
  file: string;
  flags?: number;
  /**
   * "export"      module export, from the API index
   * "declaration" any declaration, from workspace/symbol (includeLocals)
   * "navbar"      a symbol inside the `file` hint, incl. object-literal keys
   */
  via: "export" | "declaration" | "navbar";
  /** Enclosing symbol path, e.g. "rpcHandlers". Only from the navbar half. */
  container?: string;
  line?: number;
  column?: number;
  kind?: string;
  matchKind?: "exact" | "case-insensitive" | "prefix" | "substring";
}

export interface NavigateResult {
  /** The returned slice. Capped by maxResults — the counts below are not. */
  hits: NavigateHit[];
  /** Exported symbols found via the index. ALWAYS exact and complete. */
  exportHits: number;
  /** Additional non-exported declarations found via the LSP. Subject to the cap. */
  localHits: number;
  /** Additional matches found inside the `file` hint. Exact for that one file. */
  navbarHits: number;
  /**
   * True when the LSP half hit its 256 cap.
   *
   * Deliberately NOT a single `truncated` flag over the whole result: the
   * export half comes from the index and stays exact even when the locals half
   * saturates. Collapsing both into one flag would make callers discard exact
   * export counts — precisely the counts deep-survey's prevalence analysis
   * depends on.
   */
  localsTruncated: boolean;
  /** Total matches before maxResults trimmed the list. */
  totalHits: number;
  /** True when maxResults dropped some. The counts above still describe them all. */
  listTrimmed: boolean;
  source: "index" | "lsp" | "both";
}

/** The tool exists to shrink context, not fill it. */
export const DEFAULT_MAX_RESULTS = 10;

/**
 * Match quality, lowest first.
 *
 * Only matters because maxResults trims the list: with an arbitrary order, the
 * 10 survivors of a 1500-hit query would be whichever files the index walk
 * happened to reach first, and an exact match could be dropped in favour of a
 * long incidental substring. Sorting makes the trim defensible.
 */
function rank(name: string, query: string): number {
  if (name === query) return 0;
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 1;
  if (n.startsWith(q)) return 2;
  return 3;
}

function matchKind(name: string, query: string): NavigateHit["matchKind"] {
  if (name === query) return "exact";
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return "case-insensitive";
  if (n.startsWith(q)) return "prefix";
  return "substring";
}

function byRelevance(query: string) {
  return (a: NavigateHit, b: NavigateHit): number => {
    const ra = rank(a.name, query);
    const rb = rank(b.name, query);
    if (ra !== rb) return ra - rb;
    // A shorter name containing the query is a tighter match than a longer one.
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name === b.name ? a.file.localeCompare(b.file) : a.name.localeCompare(b.name);
  };
}

export interface BuildStats {
  indexedFiles: number;
  totalSymbols: number;
  uniqueSymbols: number;
  errors: number;
  elapsedMs: number;
}

export class NavigateTo {
  #index: IndexEntry[] = [];
  #lsp: LspClient | undefined;
  stats: BuildStats | undefined;

  readonly api: ApiClient;

  constructor(api: ApiClient) {
    this.api = api;
  }

  /**
   * Build the export index. Concurrency matters: each file costs three
   * round-trips (getSourceFile -> getSymbolAtLocation -> getExportsOfModule),
   * and getSourceFile returns a lazily-decoded RemoteSourceFile so we are not
   * paying full AST materialization.
   */
  async buildIndex({ concurrency = 8 }: { concurrency?: number } = {}): Promise<BuildStats> {
    const started = performance.now();
    const files = await this.api.projectFiles();
    const index: IndexEntry[] = [];
    let errors = 0;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= files.length) return;
        const fileName = files[i]!;
        try {
          const moduleSymbol = await this.api.moduleSymbol(fileName);
          if (!moduleSymbol) continue;
          const exports = await this.api.checker.getExportsOfModule(moduleSymbol);
          for (const ex of exports) {
            index.push({ name: ex.name, file: fileName, flags: ex.flags, id: ex.id });
          }
        } catch {
          errors++;
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    this.#index = index;

    const stats: BuildStats = {
      indexedFiles: files.length,
      totalSymbols: index.length,
      uniqueSymbols: new Set(index.map((e) => e.id)).size,
      errors,
      elapsedMs: performance.now() - started,
    };
    this.stats = stats;
    return stats;
  }

  /**
   * Re-index only the files that changed, leaving the rest of the index intact.
   *
   * Correctness note: a barrel that re-exports a changed module must ALSO be
   * re-indexed, because its export list is derived. We don't try to infer that
   * here — callers pass the `changedFiles` set that tsgo itself reports, which
   * already includes every file whose program contribution changed.
   */
  async reindex(files: readonly string[]): Promise<number> {
    if (files.length === 0) return 0;
    const target = new Set(files);

    // Drop stale entries first so a deleted export does not linger.
    this.#index = this.#index.filter((e) => !target.has(e.file));

    let added = 0;
    for (const fileName of target) {
      try {
        const moduleSymbol = await this.api.moduleSymbol(fileName);
        if (!moduleSymbol) continue;
        const exports = await this.api.checker.getExportsOfModule(moduleSymbol);
        for (const ex of exports) {
          this.#index.push({ name: ex.name, file: fileName, flags: ex.flags, id: ex.id });
          added++;
        }
      } catch {
        // File removed from the program — leaving it dropped is correct.
      }
    }
    return added;
  }

  /** Drop index entries for files that no longer exist in the program. */
  forget(files: readonly string[]): void {
    if (files.length === 0) return;
    const target = new Set(files);
    this.#index = this.#index.filter((e) => !target.has(e.file));
  }

  /**
   * Barrel and star re-exports can surface the same symbol through multiple
   * modules. The TSGo symbol id dedupes repeated sightings when identity is
   * shared; named alias re-exports intentionally remain visible as their own
   * exported API entries.
   */
  queryIndex(query: string): NavigateHit[] {
    const q = query.toLowerCase();
    const seen = new Set<number>();
    const out: NavigateHit[] = [];
    for (const e of this.#index) {
      if (!e.name.toLowerCase().includes(q)) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({
        name: e.name,
        file: e.file,
        flags: e.flags,
        via: "export",
        kind: describeFlags(e.flags),
        matchKind: matchKind(e.name, query),
      });
    }
    return out;
  }

  async #ensureLsp(): Promise<LspClient> {
    if (this.#lsp) return this.#lsp;
    const exe = this.api.exe;
    if (!exe) throw new Error("ApiClient not started — no executable resolved");
    const lsp = new LspClient(exe.path, this.api.options.projectRoot);
    await lsp.start();
    // workspace/symbol returns [] until a project is loaded.
    const files = await this.api.projectFiles();
    if (files.length > 0) lsp.openFile(files[0]!);
    this.#lsp = lsp;
    return lsp;
  }

  /** Shared TSGo LSP client for editor-style tools such as hover and code actions. */
  async lspClient(): Promise<LspClient> {
    return this.#ensureLsp();
  }

  /**
   * @param includeLocals also search non-exported declarations and class
   * members via the LSP. That half is subject to the 256 cap — check
   * `localsTruncated`. `exportHits` stays exact either way.
   * @param file supplement with that one file's document symbols. The only way
   * to reach object-literal property keys; see #collectNavbar.
   * @param maxResults trim the returned LIST only. Every count in the result
   * describes the untrimmed set, so a trimmed response is still safe to count
   * from — which is why this does not reintroduce the 256-cap hazard.
   */
  async query(
    symbol: string,
    {
      includeLocals = false,
      file,
      maxResults = DEFAULT_MAX_RESULTS,
    }: { includeLocals?: boolean; file?: string; maxResults?: number } = {},
  ): Promise<NavigateResult> {
    const hits = this.queryIndex(symbol);
    const exportHits = hits.length;
    const known = new Set(hits.map((h) => keyOf(h.name, h.file)));
    let localsTruncated = false;
    let localHits = 0;
    let navbarHits = 0;

    if (includeLocals) {
      await this.#collectLocals(symbol, hits, known, (t) => (localsTruncated = t), () => localHits++);
    }
    if (file) {
      navbarHits = await this.#collectNavbar(symbol, file, hits, known);
    }

    const totalHits = hits.length;
    hits.sort(byRelevance(symbol));
    const trimmed = maxResults > 0 && totalHits > maxResults;
    const returnedHits = trimmed ? hits.slice(0, maxResults) : hits;
    await this.#enrichExportLocations(returnedHits);

    return {
      hits: returnedHits,
      exportHits,
      localHits,
      navbarHits,
      localsTruncated,
      totalHits,
      listTrimmed: trimmed,
      source: localHits > 0 || navbarHits > 0 ? "both" : "index",
    };
  }

  /** workspace/symbol half — non-exported declarations and class members. */
  async #collectLocals(
    symbol: string,
    hits: NavigateHit[],
    known: Set<string>,
    setTruncated: (t: boolean) => void,
    counted: () => void,
  ): Promise<void> {
    const lsp = await this.#ensureLsp();
    const lspResult = await lsp.workspaceSymbol(symbol);
    setTruncated(lspResult.truncated);

    // Merge: index entries win (exact + already deduped); add LSP-only names,
    // which is where locals and class members come from.
    for (const s of lspResult.symbols) {
      const file = s.uri.startsWith("file://") ? fileURLToPath(s.uri) : s.uri;
      const key = keyOf(s.name, file);
      if (known.has(key)) continue;
      known.add(key);
      hits.push({
        name: s.name,
        file,
        via: "declaration",
        kind: `lsp:${s.kind}`,
        matchKind: matchKind(s.name, symbol),
        ...(s.line !== undefined ? { line: s.line, column: s.column } : {}),
      });
      counted();
    }
  }

  /**
   * The `file` hint. Document symbols for that one file, which is the only
   * route to object-literal property keys — invisible to both the export index
   * and workspace/symbol, and how RPC handler maps and route tables are written.
   */
  async #collectNavbar(
    symbol: string,
    file: string,
    hits: NavigateHit[],
    known: Set<string>,
  ): Promise<number> {
    const abs = path.resolve(this.api.options.projectRoot, file);
    const lsp = await this.#ensureLsp();
    const q = symbol.toLowerCase();
    let added = 0;
    // Substring, not exact: the caller is searching, and the handler they want
    // is as likely to be `getUserProfile` for a query of `UserProfile`.
    for (const s of await lsp.documentSymbol(abs).catch(() => [])) {
      if (!s.name.toLowerCase().includes(q)) continue;
      const key = keyOf(s.name, abs);
      if (known.has(key)) continue;
      known.add(key);
      hits.push({
        name: s.name,
        file: abs,
        via: "navbar",
        ...(s.container ? { container: s.container } : {}),
        kind: `lsp:${s.kind}`,
        matchKind: matchKind(s.name, symbol),
        ...(s.line !== undefined ? { line: s.line, column: s.column } : {}),
      });
      added++;
    }
    return added;
  }

  async #enrichExportLocations(hits: NavigateHit[]): Promise<void> {
    const byFile = new Map<string, NavigateHit[]>();
    for (const hit of hits) {
      if (hit.via !== "export" || hit.line !== undefined) continue;
      const list = byFile.get(hit.file) ?? [];
      list.push(hit);
      byFile.set(hit.file, list);
    }
    if (byFile.size === 0) return;

    const lsp = await this.#ensureLsp();
    for (const [file, fileHits] of byFile) {
      const symbols = await lsp.documentSymbol(file).catch(() => []);
      const byName = new Map<string, typeof symbols>();
      for (const s of symbols) {
        const list = byName.get(s.name) ?? [];
        list.push(s);
        byName.set(s.name, list);
      }
      for (const hit of fileHits) {
        const candidate = byName.get(hit.name)?.[0];
        if (!candidate?.line) continue;
        hit.line = candidate.line;
        hit.column = candidate.column;
        if (candidate.container) hit.container ??= candidate.container;
        hit.kind ??= `lsp:${candidate.kind}`;
      }
    }
  }

  async documentSymbols(file: string, symbol?: string): Promise<NavigateHit[]> {
    const abs = path.resolve(this.api.options.projectRoot, file);
    const lsp = await this.#ensureLsp();
    const q = symbol?.toLowerCase();
    return (await lsp.documentSymbol(abs))
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .map((s) => ({
        name: s.name,
        file: abs,
        via: "navbar" as const,
        ...(s.container ? { container: s.container } : {}),
        kind: `lsp:${s.kind}`,
        ...(symbol ? { matchKind: matchKind(s.name, symbol) } : {}),
        ...(s.line !== undefined ? { line: s.line, column: s.column } : {}),
      }));
  }

  async close(): Promise<void> {
    await this.#lsp?.stop();
    this.#lsp = undefined;
  }
}

/**
 * Warning to attach to a result whose locals half was capped.
 *
 * Deliberately scoped: it tells the caller the LOCAL count is a floor while
 * confirming the export count is still exact. A blanket "results truncated"
 * would push callers to discard exact export counts too.
 */
export function truncationNotice(result: NavigateResult): string | undefined {
  if (!result.localsTruncated) return undefined;
  return (
    `The non-exported half of this search was truncated at ${RESULT_CAP} by tsgo's ` +
    `workspace/symbol cap, so localHits (${result.localHits}) is a floor, not a total. ` +
    `exportHits (${result.exportHits}) is unaffected and remains exact — use it for ` +
    `any prevalence or comparison work. To avoid the cap entirely, query with ` +
    `includeLocals=false.`
  );
}
