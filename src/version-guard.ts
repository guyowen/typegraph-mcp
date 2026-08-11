/**
 * Version guard for the tsgo --api transport.
 *
 * `tsgo --api` speaks JSON-RPC with a msgpack payload encoder, and has NO
 * protocol version negotiation — InitializeResponse carries only
 * `useCaseSensitiveFileNames` and `currentDirectory`. The encoder/decoder on
 * both sides is code-generated from the same commit, so when the JS client and
 * the tsgo binary come from different commits you get msgpack decode errors
 * deep inside a request rather than a clean "version mismatch".
 *
 * @effect/tsgo records exactly which typescript-go commit its binary was built
 * from in `_packages/tsgo/upstream.json`. We compare that against the
 * `typescript` package supplying our client and refuse to run on a mismatch.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface VersionInfo {
  /** Version of the `typescript` package supplying the unstable API client */
  clientVersion: string;
  /** typescript version @effect/tsgo pins on the channel it shipped */
  binaryPinnedVersion: string | null;
  /** typescript-go commit that pin resolves to */
  binaryGitHead: string | null;
  /** Which upstream.json channel matched ("latest" | "next" | null) */
  channel: string | null;
  effectTsgoVersion: string | null;
  agrees: boolean;
}

interface UpstreamManifest {
  schemaVersion: number;
  tags: Record<string, Record<string, string>>;
  components: Record<string, Record<string, { gitHead: string }>>;
}

function resolvePackageJson(spec: string): Record<string, unknown> | null {
  try {
    return require(`${spec}/package.json`) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Locate @effect/tsgo's upstream.json.
 *
 * It does NOT ship in the main `@effect/tsgo` package — that publishes only
 * dist/, lib/, and the two schema files. The manifest ships alongside the
 * binary in the per-platform optional dependency, e.g.
 * `@effect/tsgo-darwin-arm64/lib/upstream.json`. Checking the main package
 * first anyway, in case that changes upstream.
 */
function readUpstreamManifest(): UpstreamManifest | null {
  const specs = [
    `@effect/tsgo-${process.platform}-${process.arch}`,
    "@effect/tsgo",
  ];
  const relatives = ["lib/upstream.json", "upstream.json", "dist/upstream.json"];

  for (const spec of specs) {
    let pkgPath: string;
    try {
      pkgPath = require.resolve(`${spec}/package.json`);
    } catch {
      continue;
    }
    const dir = path.dirname(pkgPath);
    for (const rel of relatives) {
      const full = path.join(dir, rel);
      if (!fs.existsSync(full)) continue;
      try {
        return JSON.parse(fs.readFileSync(full, "utf-8")) as UpstreamManifest;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function inspectVersions(): VersionInfo {
  const tsPkg = resolvePackageJson("typescript");
  const clientVersion = (tsPkg?.version as string) ?? "unknown";

  const effectPkg = resolvePackageJson("@effect/tsgo");
  const effectTsgoVersion = (effectPkg?.version as string) ?? null;

  const manifest = readUpstreamManifest();
  if (!manifest) {
    return {
      clientVersion,
      binaryPinnedVersion: null,
      binaryGitHead: null,
      channel: null,
      effectTsgoVersion,
      // Nothing to contradict us. Don't hard-fail on a missing manifest —
      // Effect may reorganize the package; check.ts reports this as a warning.
      agrees: true,
    };
  }

  // upstream.json pins typescript per channel: { tags: { typescript: { latest, next } } }
  const tags = manifest.tags?.typescript ?? {};
  let channel: string | null = null;
  let binaryPinnedVersion: string | null = null;

  for (const [tag, version] of Object.entries(tags)) {
    if (version === clientVersion) {
      channel = tag;
      binaryPinnedVersion = version;
      break;
    }
  }
  if (!binaryPinnedVersion) {
    // No channel matches our client. Report `latest` as the expected value.
    binaryPinnedVersion = tags.latest ?? null;
  }

  const gitHead =
    binaryPinnedVersion
      ? (manifest.components?.typescript?.[binaryPinnedVersion]?.gitHead ?? null)
      : null;

  return {
    clientVersion,
    binaryPinnedVersion,
    binaryGitHead: gitHead,
    channel,
    effectTsgoVersion,
    agrees: channel !== null,
  };
}

export class VersionSkewError extends Error {
  // NOTE: an explicit field + assignment, not a `readonly` parameter property.
  // Parameter properties are not erasable, so they break `node file.ts` under
  // strip-only type stripping. The whole package avoids them deliberately.
  readonly info: VersionInfo;

  constructor(info: VersionInfo) {
    super(
      `tsgo API version skew: the 'typescript' package supplying the API client is ` +
        `${info.clientVersion}, but @effect/tsgo${info.effectTsgoVersion ? ` ${info.effectTsgoVersion}` : ""} ` +
        `ships a binary built from typescript ${info.binaryPinnedVersion ?? "unknown"}. ` +
        `The --api protocol has no version handshake, so mismatches surface as msgpack ` +
        `decode errors. Install typescript@${info.binaryPinnedVersion ?? "<pinned>"} to match.`,
    );
    this.info = info;
    this.name = "VersionSkewError";
  }
}

export function assertVersionsAgree(): VersionInfo {
  const info = inspectVersions();
  if (!info.agrees) throw new VersionSkewError(info);
  return info;
}
