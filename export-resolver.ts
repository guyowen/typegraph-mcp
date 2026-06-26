/**
 * Export Resolver — Module export analysis using oxc-parser + tsserver.
 *
 * Extracted from server.ts for modularity. Handles:
 * - Parsing export entries from AST
 * - Resolving re-exports through barrel files
 * - Tracking export metadata (kind, type, source)
 * - Conflict resolution for star re-exports
 */

import { parseSync } from "oxc-parser";
import type { ResolverFactory } from "oxc-resolver";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TsServerClient } from "./src/core/tsserver/index.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ModuleExportRecord = {
  symbol: string;
  kind: string;
  line: number;
  type: string | null;
  exportKind: "value" | "type";
  isTypeOnly: boolean;
  isNamespace: boolean;
  source: "local" | "re-export" | "star-re-export";
  from: string | null;
  definedIn: string;
  definedLine: number | null;
};

export type StaticExportEntry = ReturnType<
  typeof parseSync
>["module"]["staticExports"][number]["entries"][number];

// ─── Constants ───────────────────────────────────────────────────────────────

export const EXPORT_KINDS = new Set([
  "function",
  "const",
  "class",
  "interface",
  "type",
  "enum",
  "var",
  "let",
  "method",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function exportPriority(source: ModuleExportRecord["source"]): number {
  switch (source) {
    case "local":
      return 3;
    case "re-export":
      return 2;
    case "star-re-export":
      return 1;
  }
}

export function exportKey(
  item: Pick<ModuleExportRecord, "symbol" | "exportKind">,
): string {
  return `${item.symbol}:${item.exportKind}`;
}

export function sameExportOrigin(
  a: ModuleExportRecord,
  b: ModuleExportRecord,
): boolean {
  return (
    a.symbol === b.symbol &&
    a.exportKind === b.exportKind &&
    a.from === b.from &&
    a.definedIn === b.definedIn &&
    a.definedLine === b.definedLine
  );
}

export function kindImpliesTypeOnly(kind: string): boolean {
  return kind === "type" || kind === "interface";
}

export function normalizeExportKindLabel(
  kind: string,
  exportKind: ModuleExportRecord["exportKind"],
): string {
  if (exportKind === "type" && !kindImpliesTypeOnly(kind)) {
    return "type";
  }
  return kind;
}

export function upsertExport(
  map: Map<string, ModuleExportRecord>,
  conflicts: Set<string>,
  nextExport: ModuleExportRecord,
): void {
  const key = exportKey(nextExport);
  if (conflicts.has(key)) {
    if (nextExport.source === "star-re-export") return;
    conflicts.delete(key);
    map.set(key, nextExport);
    return;
  }

  const existing = map.get(key);
  if (
    existing &&
    existing.source === "star-re-export" &&
    nextExport.source === "star-re-export" &&
    !sameExportOrigin(existing, nextExport)
  ) {
    map.delete(key);
    conflicts.add(key);
    return;
  }

  if (
    !existing ||
    exportPriority(nextExport.source) > exportPriority(existing.source)
  ) {
    map.set(key, nextExport);
  }
}

export function offsetToLineColumn(
  source: string,
  offset: number | null | undefined,
): {
  line: number;
  column: number;
} {
  const safeOffset = Math.max(0, Math.min(offset ?? 0, source.length));
  const prefix = source.slice(0, safeOffset);
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

export function normalizeExistingPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function projectPath(file: string, projectRoot: string): string {
  return path.isAbsolute(file) ? path.relative(projectRoot, file) : file;
}

export function exportSymbol(entry: StaticExportEntry): string | null {
  if (entry.exportName.kind === "Default") return "default";
  return entry.exportName.name ?? entry.localName.name ?? entry.importName.name;
}

export function exportLookupOffset(
  entry: StaticExportEntry,
): number | null | undefined {
  if ((entry as { moduleRequest?: { value: string } }).moduleRequest) {
    return entry.importName.start ?? entry.exportName.start ?? entry.start;
  }
  if (entry.exportName.kind === "Default") {
    return entry.localName.start ?? entry.exportName.start ?? entry.start;
  }
  return entry.exportName.start ?? entry.localName.start ?? entry.start;
}

// ─── Core ────────────────────────────────────────────────────────────────────

export async function resolveExportMetadata(
  client: TsServerClient,
  relFile: string,
  line: number,
  column: number,
  fallbackKind: string,
  projectRoot: string,
): Promise<{
  kind: string;
  type: string | null;
  definedIn: string;
  definedLine: number | null;
}> {
  const defs = await client.definition(relFile, line, column);
  const def = defs[0] ?? null;

  let info = await client.quickinfo(relFile, line, column);
  if ((!info || info.kind === "alias") && def) {
    info =
      (await client.quickinfo(def.file, def.start.line, def.start.offset)) ??
      info;
  }

  return {
    kind: info?.kind ?? fallbackKind,
    type: info?.displayString ?? null,
    definedIn: projectPath(def?.file ?? relFile, projectRoot),
    definedLine: def?.start.line ?? null,
  };
}

export async function getModuleExports(
  client: TsServerClient,
  moduleResolver: ResolverFactory,
  projectRoot: string,
  relPathFn: (absPath: string) => string,
  resolveProjectImportFn: (fromDir: string, specifier: string) => string | null,
  file: string,
  visited = new Set<string>(),
): Promise<ModuleExportRecord[]> {
  const exportCache = new Map<string, ModuleExportRecord[]>();
  const relFile = path.isAbsolute(file) ? relPathFn(file) : file;
  const absFile = normalizeExistingPath(client.resolvePath(relFile));
  if (visited.has(absFile)) return [];

  const nextVisited = new Set(visited);
  nextVisited.add(absFile);

  const exportMap = new Map<string, ModuleExportRecord>();
  const conflictingStarExports = new Set<string>();

  let source: string;
  try {
    source = fs.readFileSync(absFile, "utf-8");
  } catch {
    return [...exportMap.values()];
  }

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(absFile, source);
  } catch {
    return [...exportMap.values()];
  }

  for (const exp of parsed.module.staticExports) {
    for (const entry of exp.entries) {
      const moduleRequest = (entry as { moduleRequest?: { value: string } })
        .moduleRequest;
      if (!moduleRequest) continue;

      const targetFile = resolveProjectImportFn(
        path.dirname(absFile),
        moduleRequest.value,
      );

      const exportLoc = offsetToLineColumn(
        source,
        entry.exportName.start ??
          entry.localName.start ??
          entry.importName.start ??
          entry.start,
      );
      const importKind = entry.importName.kind as string;
      const exportKind = entry.exportName.kind as string;

      if (importKind === "AllButDefault" && exportKind === "None") {
        if (!targetFile) continue;
        let nestedExports = exportCache.get(targetFile);
        if (!nestedExports) {
          nestedExports = await getModuleExports(
            client,
            moduleResolver,
            projectRoot,
            relPathFn,
            resolveProjectImportFn,
            targetFile,
            nextVisited,
          );
          exportCache.set(targetFile, nestedExports);
        }
        for (const nested of nestedExports) {
          if (nested.symbol === "default") continue;
          const starExportKind: ModuleExportRecord["exportKind"] = entry.isType
            ? "type"
            : nested.exportKind;
          upsertExport(exportMap, conflictingStarExports, {
            ...nested,
            line: exportLoc.line,
            exportKind: starExportKind,
            isTypeOnly: starExportKind === "type",
            source: "star-re-export",
            from: relPathFn(targetFile),
          });
        }
        continue;
      }

      const symbol = exportSymbol(entry);
      if (!symbol) continue;

      const importedSymbol =
        importKind === "Default"
          ? "default"
          : importKind === "Name"
            ? entry.importName.name
            : null;
      const nestedMatch =
        targetFile && importedSymbol
          ? await (async () => {
              let exports = exportCache.get(targetFile);
              if (!exports) {
                exports = await getModuleExports(
                  client,
                  moduleResolver,
                  projectRoot,
                  relPathFn,
                  resolveProjectImportFn,
                  targetFile,
                  nextVisited,
                );
                exportCache.set(targetFile, exports);
              }
              return (
                exports.find((item) => item.symbol === importedSymbol) ?? null
              );
            })()
          : null;

      const lookupLoc = offsetToLineColumn(source, exportLookupOffset(entry));
      const metadata = await resolveExportMetadata(
        client,
        relFile,
        lookupLoc.line,
        lookupLoc.column,
        importKind === "All" ? "namespace" : "alias",
        projectRoot,
      );
      const resolvedExportKind: ModuleExportRecord["exportKind"] =
        entry.isType ||
        nestedMatch?.exportKind === "type" ||
        kindImpliesTypeOnly(nestedMatch?.kind ?? metadata.kind)
          ? "type"
          : "value";
      const resolvedKind = normalizeExportKindLabel(
        nestedMatch?.kind ?? metadata.kind,
        resolvedExportKind,
      );

      upsertExport(exportMap, conflictingStarExports, {
        symbol,
        kind: resolvedKind,
        line: exportLoc.line,
        type: nestedMatch?.type ?? metadata.type,
        exportKind: resolvedExportKind,
        isTypeOnly: resolvedExportKind === "type",
        isNamespace: importKind === "All",
        source: "re-export",
        from: targetFile ? relPathFn(targetFile) : moduleRequest.value,
        definedIn: nestedMatch?.definedIn ?? metadata.definedIn,
        definedLine: nestedMatch?.definedLine ?? metadata.definedLine,
      });
      continue;
    }

    const localEntries: {
      entry: StaticExportEntry;
      symbol: string;
      exportLoc: { line: number; column: number };
      lookupLoc: { line: number; column: number };
    }[] = [];

    for (const entry of exp.entries) {
      const moduleRequest = (entry as { moduleRequest?: { value: string } })
        .moduleRequest;
      if (moduleRequest) continue;

      const symbol = exportSymbol(entry);
      if (!symbol) continue;

      const exportLoc = offsetToLineColumn(
        source,
        entry.exportName.start ?? entry.localName.start ?? entry.start,
      );
      const lookupLoc = offsetToLineColumn(source, exportLookupOffset(entry));
      localEntries.push({ entry, symbol, exportLoc, lookupLoc });
    }

    const localResults = await Promise.all(
      localEntries.map((e) =>
        resolveExportMetadata(
          client,
          relFile,
          e.lookupLoc.line,
          e.lookupLoc.column,
          e.entry.isType ? "type" : "value",
          projectRoot,
        ).then((metadata) => ({ ...e, metadata })),
      ),
    );

    for (const { entry, symbol, exportLoc, metadata } of localResults) {
      const resolvedExportKind: ModuleExportRecord["exportKind"] =
        entry.isType || kindImpliesTypeOnly(metadata.kind) ? "type" : "value";
      const resolvedKind = normalizeExportKindLabel(
        metadata.kind,
        resolvedExportKind,
      );

      if (
        resolvedExportKind === "value" &&
        symbol !== "default" &&
        !EXPORT_KINDS.has(resolvedKind) &&
        resolvedKind !== "namespace" &&
        resolvedKind !== "class"
      ) {
        continue;
      }

      upsertExport(exportMap, conflictingStarExports, {
        symbol,
        kind: resolvedKind,
        line: exportLoc.line,
        type: metadata.type,
        exportKind: resolvedExportKind,
        isTypeOnly: resolvedExportKind === "type",
        isNamespace: false,
        source: "local",
        from: null,
        definedIn: relFile,
        definedLine:
          resolvedExportKind === "type" ? exportLoc.line : metadata.definedLine,
      });
    }
  }

  return [...exportMap.values()].sort(
    (a, b) => a.line - b.line || a.symbol.localeCompare(b.symbol),
  );
}
