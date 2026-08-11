/**
 * Semantic backend for TypeGraph-Go.
 *
 * Spawns the tsgo binary in `--api` mode and talks to it through the client
 * shipped in `typescript/unstable/async`.
 *
 * Why the @effect/tsgo binary rather than typescript's own: Effect's build is a
 * superset — same upstream typescript-go commit, plus Effect-aware checker and
 * hover patches — and `--api` survives their patch set untouched
 * (_patches/typescript-go/001-cmd-tsgo-main.patch only *adds* a case). So on an
 * Effect codebase, type display comes back Effect-aware for free. We fall back
 * to typescript's bundled binary when @effect/tsgo isn't installed.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { API } from "typescript/unstable/async";
import { assertVersionsAgree, type VersionInfo } from "./version-guard.ts";

const require = createRequire(import.meta.url);

export interface ResolvedExe {
  path: string;
  source: "@effect/tsgo" | "typescript";
}

const EXE_PROVIDERS = [
  { source: "@effect/tsgo", specifier: "@effect/tsgo/lib/getExePath" },
  { source: "typescript", specifier: "typescript/lib/getExePath.js" },
] as const;

function resolveProvider(specifier: string): string {
  if (specifier === "typescript/lib/getExePath.js") {
    // TypeScript 7 ships the helper but does not export the lib/ subpath.
    // Resolve the package root and import the file directly so this fallback is
    // not blocked by package exports.
    const packageJson = require.resolve("typescript/package.json");
    return path.join(path.dirname(packageJson), "lib", "getExePath.js");
  }
  return require.resolve(specifier);
}

/**
 * Both @effect/tsgo and typescript expose a getExePath() helper following the
 * same convention, and the API client's ClientSpawnOptions accepts an arbitrary
 * `tsserverPath`. That's the seam the two packages compose on.
 *
 * "Not installed" and "installed but unusable" are kept apart deliberately.
 * Only the first is worth falling through on; collapsing them — as this
 * function used to — discards the one message that says what to do, because
 * @effect/tsgo's getExePath() has a requirement that is not obvious from here:
 * it resolves a native TypeScript package from process.cwd(), which is the
 * project being analysed, NOT from this package. TypeScript 5 projects therefore
 * fall through to this package's bundled TypeScript 7 binary.
 */
export async function resolveExePath(projectRoot = process.cwd()): Promise<ResolvedExe> {
  const attempts: string[] = [];

  for (const { source, specifier } of EXE_PROVIDERS) {
    let resolved: string;
    try {
      resolved = resolveProvider(specifier);
    } catch {
      attempts.push(`${source}: not installed`);
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
      const getExePath = (mod.default ?? mod) as () => string;
      const cwd = process.cwd();
      try {
        process.chdir(projectRoot);
        return { path: getExePath(), source };
      } finally {
        process.chdir(cwd);
      }
    } catch (err) {
      attempts.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    "Could not resolve a tsgo executable.\n" +
      attempts.map((a) => `    ${a}`).join("\n") +
      `\n    Note: the Effect-patched provider resolves native TypeScript from ${projectRoot};\n` +
      "    TypeScript 5 projects should fall back to the bundled TypeScript 7 runtime. If both failed, reinstall typegraph-mcp.",
  );
}

export interface ApiClientOptions {
  projectRoot: string;
  tsconfig: string;
  /** Skip the version-skew assertion. Only for diagnostics; see version-guard.ts. */
  skipVersionCheck?: boolean;
}

/**
 * A live tsgo API session bound to one tsconfig project.
 *
 * NOTE ON LIFETIME: a snapshot is immutable. Any file edit requires a new
 * snapshot via refresh(); symbol/type handles from a previous snapshot are not
 * valid across that boundary.
 */
export class ApiClient {
  #api: API | undefined;
  #project: any;
  #snapshot: any;

  readonly versions: VersionInfo | undefined;
  exe: ResolvedExe | undefined;
  readonly options: ApiClientOptions;

  private constructor(options: ApiClientOptions) {
    const projectRoot = path.resolve(options.projectRoot);
    this.options = {
      ...options,
      projectRoot,
      tsconfig: path.isAbsolute(options.tsconfig)
        ? path.relative(projectRoot, options.tsconfig)
        : options.tsconfig,
    };
  }

  static async create(options: ApiClientOptions): Promise<ApiClient> {
    const client = new ApiClient(options);
    await client.#start();
    return client;
  }

  async #start(): Promise<void> {
    if (!this.options.skipVersionCheck) assertVersionsAgree();
    this.exe = await resolveExePath(this.options.projectRoot);
    this.#api = new API({
      tsserverPath: this.exe.path,
      cwd: this.options.projectRoot,
    });
    await this.refresh();
  }

  /** Take a fresh snapshot. Invalidates every handle from the previous one. */
  async refresh(): Promise<void> {
    await this.#snapshotWith({ openProject: this.options.tsconfig });
  }

  /**
   * Advance the snapshot, telling tsgo exactly which files moved.
   *
   * `updateSnapshot` accepts a `fileChanges` summary, so a targeted edit does
   * not force a full program rebuild. The response reports back, per project,
   * which source files actually changed — which is what makes downstream
   * invalidation surgical instead of guesswork: we re-index precisely those
   * files rather than diffing or rebuilding.
   */
  async applyChanges(changes: {
    changed?: string[];
    created?: string[];
    deleted?: string[];
  }): Promise<{ changedFiles: string[]; deletedFiles: string[] }> {
    const response = await this.#snapshotWith({
      openProject: this.options.tsconfig,
      fileChanges: changes,
    });

    const perProject = response?.changes?.changedProjects ?? {};
    const changedFiles: string[] = [];
    const deletedFiles: string[] = [];
    for (const info of Object.values(perProject) as any[]) {
      changedFiles.push(...(info?.changedFiles ?? []));
      deletedFiles.push(...(info?.deletedFiles ?? []));
    }
    // Fall back to what the caller told us if the server reported nothing —
    // a project it does not track still needs local caches dropped.
    if (changedFiles.length === 0 && deletedFiles.length === 0) {
      changedFiles.push(...(changes.changed ?? []), ...(changes.created ?? []));
      deletedFiles.push(...(changes.deleted ?? []));
    }
    return { changedFiles, deletedFiles };
  }

  async #snapshotWith(params: Record<string, unknown>): Promise<any> {
    if (!this.#api) throw new Error("ApiClient not started");
    this.#snapshot = await (this.#api as any).updateSnapshot(params);
    this.#project = this.#snapshot.getProject(this.options.tsconfig);
    if (!this.#project) {
      throw new Error(`tsgo opened no project for ${this.options.tsconfig}`);
    }
    return this.#snapshot;
  }

  get project(): any {
    if (!this.#project) throw new Error("ApiClient not started");
    return this.#project;
  }

  get checker(): any {
    return this.project.checker;
  }

  get program(): any {
    return this.project.program;
  }

  /** Project source files, excluding lib.d.ts and node_modules. */
  async projectFiles(): Promise<string[]> {
    const all: readonly string[] = await this.program.getSourceFileNames();
    return all.filter(
      (f) =>
        f.startsWith(this.options.projectRoot) &&
        !f.includes("node_modules") &&
        !f.endsWith(".d.ts"),
    );
  }

  /**
   * Resolve a module symbol for a file — the entry point for export analysis.
   * getSourceFile returns a lazily-decoded RemoteSourceFile, so this does not
   * pay full AST materialization cost.
   */
  async moduleSymbol(fileName: string): Promise<any | undefined> {
    const sf = await this.program.getSourceFile(fileName);
    if (!sf) return undefined;
    return await this.checker.getSymbolAtLocation(sf);
  }

  async close(): Promise<void> {
    await this.#api?.close();
    this.#api = undefined;
    this.#project = undefined;
    this.#snapshot = undefined;
  }
}
