/**
 * TSConfig Patch — tsconfig.json and lint config patching.
 *
 * Extracted from cli.ts for modularity. Handles:
 * - Adding plugins/** to tsconfig.json exclude
 * - Adding plugins/** to ESLint/Oxlint ignore patterns
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

const ESLINT_CONFIG_NAMES = [
  "eslint.config.mjs",
  "eslint.config.js",
  "eslint.config.ts",
  "eslint.config.cjs",
];

const OXLINT_CONFIG_NAMES = [
  ".oxlintrc.json",
  "oxlint.config.ts",
  "oxlint.config.js",
  "oxlint.config.mjs",
  "oxlint.config.cjs",
];

// ─── Types ───────────────────────────────────────────────────────────────────

type LintConfig =
  | { tool: "ESLint"; fileName: string; fullPath: string; format: "flat" }
  | {
      tool: "Oxlint";
      fileName: string;
      fullPath: string;
      format: "json" | "module";
    };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function appendToArrayLiteral(
  raw: string,
  propertyPattern: RegExp,
  valueLiteral: string,
): string | null {
  if (!propertyPattern.test(raw)) return null;
  return raw.replace(propertyPattern, (_match, open, items, close) => {
    const trimmed = items.trimEnd();
    const needsComma = trimmed.length > 0 && !trimmed.endsWith(",");
    return `${open}${items.trimEnd()}${needsComma ? "," : ""} ${valueLiteral}${close}`;
  });
}

function insertTopLevelJsonArrayProperty(
  raw: string,
  propertyName: string,
  valueLiteral: string,
): string | null {
  const lastBrace = raw.lastIndexOf("}");
  if (lastBrace === -1) return null;
  const before = raw.slice(0, lastBrace).trimEnd();
  const needsComma = !before.endsWith(",") && !before.endsWith("{");
  return `${before}${needsComma ? "," : ""}\n  "${propertyName}": [${valueLiteral}]\n}\n`;
}

// ─── Lint Config Detection ───────────────────────────────────────────────────

export function findLintConfigs(projectRoot: string): LintConfig[] {
  const configs: LintConfig[] = [];

  for (const fileName of ESLINT_CONFIG_NAMES) {
    const fullPath = path.resolve(projectRoot, fileName);
    if (fs.existsSync(fullPath)) {
      configs.push({ tool: "ESLint", fileName, fullPath, format: "flat" });
    }
  }

  for (const fileName of OXLINT_CONFIG_NAMES) {
    const fullPath = path.resolve(projectRoot, fileName);
    if (fs.existsSync(fullPath)) {
      configs.push({
        tool: "Oxlint",
        fileName,
        fullPath,
        format: fileName.endsWith(".json") ? "json" : "module",
      });
    }
  }

  return configs;
}

// ─── Patch Functions ─────────────────────────────────────────────────────────

function patchEslintConfig(raw: string): string | null {
  const updatedIgnores = appendToArrayLiteral(
    raw,
    /(ignores\s*:\s*\[)([\s\S]*?)(\])/,
    '"plugins/**"',
  );
  if (updatedIgnores) return updatedIgnores;

  const exportArrayRe = /(export\s+default\s+(?:\w+\.config\(|\[))\s*\n?/;
  if (exportArrayRe.test(raw)) {
    return raw.replace(
      exportArrayRe,
      (match) => `${match}  { ignores: ["plugins/**"] },\n`,
    );
  }

  return null;
}

function patchOxlintJsonConfig(raw: string): string | null {
  const updatedIgnores = appendToArrayLiteral(
    raw,
    /("ignorePatterns"\s*:\s*\[)([\s\S]*?)(\])/,
    '"plugins/**"',
  );
  if (updatedIgnores) return updatedIgnores;
  return insertTopLevelJsonArrayProperty(raw, "ignorePatterns", '"plugins/**"');
}

function patchOxlintModuleConfig(raw: string): string | null {
  const updatedIgnores = appendToArrayLiteral(
    raw,
    /(ignorePatterns\s*:\s*\[)([\s\S]*?)(\])/,
    '"plugins/**"',
  );
  if (updatedIgnores) return updatedIgnores;

  const exportObjectRe = /(export\s+default\s*\{)\s*\n?/;
  if (exportObjectRe.test(raw)) {
    return raw.replace(
      exportObjectRe,
      (match) => `${match}\n  ignorePatterns: ["plugins/**"],`,
    );
  }

  return null;
}

// ─── Public Functions ────────────────────────────────────────────────────────

export function ensureTsconfigExclude(
  projectRoot: string,
  logFn: { success: (msg: string) => void; warn: (msg: string) => void },
): void {
  const tsconfigPath = path.resolve(projectRoot, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return;

  try {
    const raw = fs.readFileSync(tsconfigPath, "utf-8");
    const excludeArrayMatch = raw.match(/("exclude"\s*:\s*\[)([\s\S]*?)(\])/);
    if (
      excludeArrayMatch &&
      excludeArrayMatch[2] !== undefined &&
      /["']plugins(?:\/\*\*|\/\*|)["']/.test(excludeArrayMatch[2])
    ) {
      return;
    }

    if (excludeArrayMatch) {
      const updated = raw.replace(
        /("exclude"\s*:\s*\[)([\s\S]*?)(\])/,
        (_match, open, items, close) => {
          const trimmed = items.trimEnd();
          const needsComma = trimmed.length > 0 && !trimmed.endsWith(",");
          return `${open}${items.trimEnd()}${needsComma ? "," : ""}\n    "plugins/**"${close}`;
        },
      );
      fs.writeFileSync(tsconfigPath, updated);
    } else {
      const lastBrace = raw.lastIndexOf("}");
      if (lastBrace !== -1) {
        const before = raw.slice(0, lastBrace).trimEnd();
        const needsComma = !before.endsWith(",") && !before.endsWith("{");
        const patched = `${before}${needsComma ? "," : ""}\n  "exclude": ["plugins/**"]\n}\n`;
        fs.writeFileSync(tsconfigPath, patched);
      }
    }

    logFn.success(
      'Added "plugins/**" to tsconfig.json exclude (prevents build errors)',
    );
  } catch {
    logFn.warn(
      'Could not update tsconfig.json — manually add "plugins/**" to the exclude array to prevent build errors',
    );
  }
}

export function ensureLintIgnores(
  projectRoot: string,
  logFn: { success: (msg: string) => void; warn: (msg: string) => void },
): void {
  const configs = findLintConfigs(projectRoot);
  for (const config of configs) {
    try {
      const raw = fs.readFileSync(config.fullPath, "utf-8");
      if (/["']plugins\/\*\*["']/.test(raw)) continue;

      const updated =
        config.tool === "ESLint"
          ? patchEslintConfig(raw)
          : config.format === "json"
            ? patchOxlintJsonConfig(raw)
            : patchOxlintModuleConfig(raw);

      if (updated) {
        fs.writeFileSync(config.fullPath, updated);
        const propertyName =
          config.tool === "ESLint" ? "ignores" : "ignorePatterns";
        logFn.success(
          `Added "plugins/**" to ${config.fileName} ${propertyName}`,
        );
      } else {
        const propertyName =
          config.tool === "ESLint" ? "ignores" : "ignorePatterns";
        logFn.warn(
          `Could not patch ${config.fileName} — manually add "plugins/**" to ${propertyName}`,
        );
      }
    } catch {
      const propertyName =
        config.tool === "ESLint" ? "ignores" : "ignorePatterns";
      logFn.warn(
        `Could not update ${config.fileName} — manually add "plugins/**" to ${propertyName}`,
      );
    }
  }
}
