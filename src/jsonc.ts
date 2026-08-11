/**
 * Minimal JSONC support, needed because OpenCode accepts `opencode.jsonc`.
 *
 * typegraph-mcp's installer called JSON.parse on every config and silently
 * skipped registration on a parse error — which for a commented OpenCode config
 * would mean "MCP server never registered" with only a warning. A naive
 * comment-strip is worse: a regex would corrupt any string containing `//`
 * (URLs, Windows paths). This is a small state machine that tracks string and
 * escape context instead.
 */

/** Strip `//` and block comments, preserving everything inside string literals. */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const next = input[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Remove trailing commas left behind before `}` or `]`. */
export function stripTrailingCommas(input: string): string {
  return input.replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

/**
 * Read a JSON/JSONC config. Returns `undefined` only when the file is genuinely
 * unparseable — a missing file yields an empty object so callers can create it.
 */
export function readConfig(
  fs: typeof import("node:fs"),
  fullPath: string,
): Record<string, unknown> | undefined {
  if (!fs.existsSync(fullPath)) return {};
  const raw = fs.readFileSync(fullPath, "utf-8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      return parseJsonc(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}
