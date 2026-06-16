/**
 * TOML Helpers
 *
 * TOML config file manipulation for Codex CLI.
 * Extracted from cli.ts for reusability.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TomlBlock {
  sectionName: string | null;
  raw: string;
}

export interface TomlRemoveResult {
  content: string;
  removed: boolean;
  removedContent: string;
}

export interface TomlUpsertResult {
  content: string;
  changed: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isTomlSectionGroup(
  sectionName: string | null,
  prefix: string,
): boolean {
  return (
    sectionName === prefix || sectionName?.startsWith(`${prefix}.`) === true
  );
}

function splitTomlBlocks(content: string): TomlBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: TomlBlock[] = [];
  let sectionName: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\[([^\]]+)\]\s*$/);
    if (match) {
      if (currentLines.length > 0 || sectionName !== null) {
        blocks.push({ sectionName, raw: currentLines.join("\n") });
      }
      sectionName = match[1]!;
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
  }

  if (currentLines.length > 0 || sectionName !== null) {
    blocks.push({ sectionName, raw: currentLines.join("\n") });
  }

  return blocks;
}

// ─── Public Functions ────────────────────────────────────────────────────────

/**
 * Remove a TOML section group (e.g., [mcp_servers.typegraph] and [mcp_servers.typegraph.*])
 */
export function removeTomlSectionGroup(
  content: string,
  prefix: string,
): TomlRemoveResult {
  const blocks = splitTomlBlocks(content);
  const removedBlocks = blocks.filter((block) =>
    isTomlSectionGroup(block.sectionName, prefix),
  );
  if (removedBlocks.length === 0) {
    return { content, removed: false, removedContent: "" };
  }

  const keptBlocks = blocks.filter(
    (block) => !isTomlSectionGroup(block.sectionName, prefix),
  );
  const nextContent = keptBlocks
    .map((block) => block.raw)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  return {
    content: nextContent ? `${nextContent}\n` : "",
    removed: true,
    removedContent: removedBlocks
      .map((block) => block.raw)
      .join("\n")
      .trim(),
  };
}

/**
 * Upsert a TOML section (e.g., [mcp_servers.typegraph])
 */
export function upsertTomlSection(
  content: string,
  sectionName: string,
  block: string,
): TomlUpsertResult {
  const sectionRe = new RegExp(
    `\\n?\\[${sectionName.replace(/\./g, "\\.")}\\]\\n[\\s\\S]*?(?=\\n\\[|$)`,
  );
  const normalizedBlock = block.trim();

  if (sectionRe.test(content)) {
    const existingSection = (content.match(sectionRe)?.[0] ?? "").trim();
    if (existingSection === normalizedBlock) {
      return { content, changed: false };
    }

    const nextContent = content.replace(sectionRe, `\n${normalizedBlock}\n`);
    return { content: nextContent.trimEnd() + "\n", changed: true };
  }

  const nextContent = content
    ? content.trimEnd() + "\n\n" + normalizedBlock + "\n"
    : normalizedBlock + "\n";
  return { content: nextContent, changed: true };
}

/**
 * Check if a path equals or contains another path
 */
export function pathEqualsOrContains(
  candidatePath: string,
  targetPath: string,
): boolean {
  const path = require("node:path") as typeof import("node:path");
  const fs = require("node:fs") as typeof import("node:fs");

  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedCandidate === resolvedTarget ||
    resolvedCandidate.startsWith(`${resolvedTarget}${path.sep}`)
  ) {
    return true;
  }

  try {
    const realCandidate = fs.realpathSync(candidatePath);
    const realTarget = fs.realpathSync(targetPath);
    return (
      realCandidate === realTarget ||
      realCandidate.startsWith(`${realTarget}${path.sep}`)
    );
  } catch {
    return false;
  }
}
