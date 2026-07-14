export const BIOME_CONFIG_NAMES = [
  "biome.json",
  "biome.jsonc",
  ".biome.json",
  ".biome.jsonc",
];

function filesObjectMatch(raw: string): RegExpMatchArray | null {
  return raw.match(/(["']files["']\s*:\s*\{)([\s\S]*?)(\n?\s*\})/);
}

function filesIncludes(raw: string): string[] | null {
  const filesObject = filesObjectMatch(raw);
  if (!filesObject) return null;
  const includes = filesObject[2].match(/["']includes["']\s*:\s*\[([\s\S]*?)\]/);
  if (!includes) return null;
  return [...includes[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

export function biomeScopeExcludes(raw: string, parentDir: string): boolean {
  const escaped = parentDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const explicitIgnore = new RegExp(
    `["']!{1,2}(?:\\*\\*/)?${escaped}(?:/\\*\\*)?["']`
  );
  if (explicitIgnore.test(raw)) return true;

  const includes = filesIncludes(raw);
  if (!includes) return false;
  const positivePatterns = includes.filter((pattern) => !pattern.startsWith("!"));

  return !positivePatterns.some((pattern) => {
    const normalized = pattern.replace(/^\.\//, "");
    return (
      normalized === "*" ||
      normalized === "**" ||
      normalized.startsWith("**/") ||
      normalized.startsWith("*/") ||
      normalized === parentDir ||
      normalized.startsWith(`${parentDir}/`)
    );
  });
}

function appendToIncludes(body: string, forceIgnore: string): string | null {
  const pattern = /(["']includes["']\s*:\s*\[)([\s\S]*?)(\])/;
  if (!pattern.test(body)) return null;
  return body.replace(pattern, (_match, open, items, close) => {
    const trimmed = items.trimEnd();
    const needsComma = trimmed.length > 0 && !trimmed.endsWith(",");
    return `${open}${trimmed}${needsComma ? "," : ""} ${forceIgnore}${close}`;
  });
}

export function patchBiomeConfig(raw: string, parentDir: string): string | null {
  const forceIgnore = `"!!${parentDir}"`;
  const filesObjectRe = /(["']files["']\s*:\s*\{)([\s\S]*?)(\n?\s*\})/;
  const filesObject = filesObjectMatch(raw);

  if (filesObject) {
    const updatedBody = appendToIncludes(filesObject[2], forceIgnore);
    if (updatedBody) {
      return raw.replace(filesObjectRe, `${filesObject[1]}${updatedBody}${filesObject[3]}`);
    }

    const body = filesObject[2].trimEnd();
    const needsComma = body.trim().length > 0 && !body.trimEnd().endsWith(",");
    const updatedFiles = `${filesObject[1]}${body}${needsComma ? "," : ""}\n    "includes": ["**", ${forceIgnore}]${filesObject[3]}`;
    return raw.replace(filesObjectRe, updatedFiles);
  }

  const lastBrace = raw.lastIndexOf("}");
  if (lastBrace === -1) return null;
  const before = raw.slice(0, lastBrace).trimEnd();
  const needsComma = !before.endsWith(",") && !before.endsWith("{");
  return `${before}${needsComma ? "," : ""}\n  "files": { "includes": ["**", ${forceIgnore}] }\n}\n`;
}
