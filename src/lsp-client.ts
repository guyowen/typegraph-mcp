/**
 * Minimal tsgo LSP client for document symbols and optional local-symbol search.
 *
 * The API (--api) covers every other point query, but exposes no navigateTo /
 * workspace-symbol method. The LSP does — with two caveats measured on
 * typescript@7.0.2, both encoded below:
 *
 *  1. `workspace/symbol` searches only ALREADY-LOADED projects
 *     (snapshot.ProjectCollection.Projects()). With nothing open it returns an
 *     empty array rather than an error. openFile() forces the project tree to
 *     load.
 *
 *  2. The server issues client->server requests (observed:
 *     client/registerCapability) and BLOCKS on the reply. A client that only
 *     handles responses deadlocks on its first query.
 *
 * See also RESULT_CAP: results are truncated at 256 with no flag on the wire.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Hard-coded in typescript-go internal/ls/symbols.go:558 — `min(len(infos), 256)`. */
export const RESULT_CAP = 256;

export interface LspSymbol {
  name: string;
  kind: number;
  container: string;
  uri: string;
  /** 1-based, matching semantic.ts. Absent when the server sent no range. */
  line?: number;
  column?: number;
}

export interface LspSymbolResult {
  symbols: LspSymbol[];
  /** True when the server returned exactly RESULT_CAP results, i.e. probably truncated. */
  truncated: boolean;
}

export interface LspPosition {
  /** 1-based, matching the public MCP tools. */
  line: number;
  /** 1-based, matching the public MCP tools. */
  column: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
  data?: unknown;
}

export interface LspHover {
  kind: "markdown" | "plaintext";
  value: string;
  range?: LspRange;
  source: "@effect/tsgo-lsp";
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
}

export interface LspCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  diagnostics?: LspDiagnostic[];
  edit?: LspWorkspaceEdit;
  command?: unknown;
}

function toLspPosition(pos: LspPosition): { line: number; character: number } {
  return { line: pos.line - 1, character: pos.column - 1 };
}

function fromLspPosition(pos: { line: number; character: number }): LspPosition {
  return { line: pos.line + 1, column: pos.character + 1 };
}

function toLspRange(range: LspRange): {
  start: { line: number; character: number };
  end: { line: number; character: number };
} {
  return { start: toLspPosition(range.start), end: toLspPosition(range.end) };
}

function fromLspRange(range: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}): LspRange {
  return { start: fromLspPosition(range.start), end: fromLspPosition(range.end) };
}

function uriToPath(uri: string): string {
  return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
}

function normalizeHoverContents(contents: any): { kind: "markdown" | "plaintext"; value: string } {
  if (typeof contents === "string") return { kind: "plaintext", value: contents };
  if (Array.isArray(contents)) {
    return {
      kind: "markdown",
      value: contents
        .map((part) => (typeof part === "string" ? part : String(part?.value ?? "")))
        .filter(Boolean)
        .join("\n\n"),
    };
  }
  if (contents?.kind === "markdown" || contents?.kind === "plaintext") {
    return { kind: contents.kind, value: String(contents.value ?? "") };
  }
  if (contents?.value !== undefined) return { kind: "markdown", value: String(contents.value) };
  return { kind: "plaintext", value: "" };
}

function normalizeDiagnostic(diagnostic: any): LspDiagnostic {
  return {
    range: fromLspRange(diagnostic.range),
    ...(diagnostic.severity !== undefined ? { severity: diagnostic.severity } : {}),
    ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
    ...(diagnostic.source !== undefined ? { source: diagnostic.source } : {}),
    message: String(diagnostic.message ?? ""),
    ...(diagnostic.data !== undefined ? { data: diagnostic.data } : {}),
  };
}

function denormalizeDiagnostic(diagnostic: LspDiagnostic): Record<string, unknown> {
  return {
    range: toLspRange(diagnostic.range),
    ...(diagnostic.severity !== undefined ? { severity: diagnostic.severity } : {}),
    ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
    ...(diagnostic.source !== undefined ? { source: diagnostic.source } : {}),
    message: diagnostic.message,
    ...(diagnostic.data !== undefined ? { data: diagnostic.data } : {}),
  };
}

function normalizeWorkspaceEdit(edit: any): LspWorkspaceEdit | undefined {
  if (!edit) return undefined;
  const changes: Record<string, LspTextEdit[]> = {};
  const addChanges = (uri: string, edits: any[]): void => {
    (changes[uriToPath(uri)] ??= []).push(
      ...edits.map((textEdit) => ({
        range: fromLspRange(textEdit.range),
        newText: String(textEdit.newText ?? ""),
      })),
    );
  };
  for (const [uri, edits] of Object.entries(edit.changes ?? {}) as Array<[string, any[]]>) {
    addChanges(uri, edits);
  }
  for (const documentChange of edit.documentChanges ?? []) {
    const uri = documentChange?.textDocument?.uri;
    if (typeof uri === "string" && Array.isArray(documentChange.edits)) addChanges(uri, documentChange.edits);
  }
  return Object.keys(changes).length > 0 ? { changes } : undefined;
}

export class LspClient {
  #proc: ChildProcess | undefined;
  #closed: Promise<void> | undefined;
  #buf = Buffer.alloc(0);
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #nextId = 1;
  #openedProject = false;
  #opened = new Set<string>();
  #versions = new Map<string, number>();
  #failed = false;

  readonly exePath: string;
  readonly rootDir: string;
  readonly args: readonly string[];

  constructor(exePath: string, rootDir: string, args: readonly string[] = ["--lsp", "-stdio"]) {
    this.exePath = exePath;
    this.rootDir = rootDir;
    this.args = args;
  }

  async start(): Promise<void> {
    this.#failed = false;
    this.#proc = spawn(this.exePath, this.args, {
      cwd: this.rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const proc = this.#proc;
    this.#closed = new Promise((resolve) => {
      proc.once("close", () => resolve());
      proc.once("error", () => resolve());
    });
    const failAll = (err: Error): void => {
      this.#failed = true;
      for (const { reject } of this.#pending.values()) reject(err);
      this.#pending.clear();
    };
    this.#proc.on("error", failAll);
    this.#proc.on("exit", (code, signal) => {
      failAll(new Error(`tsgo LSP exited (${signal ?? code ?? "unknown"})`));
    });
    this.#proc.stdin!.on("error", failAll);
    this.#proc.stdout!.on("data", (c: Buffer) => this.#onData(c));
    this.#proc.stderr!.on("data", (c: Buffer) => {
      if (process.env.TYPEGRAPH_LSP_DEBUG) process.stderr.write(`[tsgo-lsp] ${c}`);
    });

    const rootUri = pathToFileURL(this.rootDir).href;
    await this.#request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "typegraph" }],
      capabilities: {
        workspace: {
          symbol: {
            symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
          },
        },
        textDocument: {
          hover: {
            contentFormat: ["markdown", "plaintext"],
          },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  "quickfix",
                  "refactor",
                  "refactor.extract",
                  "refactor.inline",
                  "refactor.rewrite",
                  "source",
                  "source.organizeImports",
                  "source.fixAll",
                ],
              },
            },
          },
        },
      },
    });
    this.#notify("initialized", {});
  }

  #onData(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const headerEnd = this.#buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.#buf.subarray(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) return;
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.#buf.length < start + len) return;
      const body = this.#buf.subarray(start, start + len).toString("utf8");
      this.#buf = this.#buf.subarray(start + len);

      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }

      // Server -> client REQUEST. Must reply or the server blocks forever.
      if (msg.method && msg.id !== undefined && msg.id !== null) {
        let result: unknown = null;
        if (msg.method === "workspace/configuration") {
          result = (msg.params?.items ?? [{}]).map(() => ({}));
        } else if (msg.method === "workspace/workspaceFolders") {
          result = [{ uri: pathToFileURL(this.rootDir).href, name: "typegraph" }];
        }
        this.#send({ jsonrpc: "2.0", id: msg.id, result });
        continue;
      }

      if (msg.id !== undefined && this.#pending.has(msg.id)) {
        const { resolve, reject } = this.#pending.get(msg.id)!;
        this.#pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }

  #send(obj: unknown): void {
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    this.#proc!.stdin!.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.#proc!.stdin!.write(payload);
  }

  #request(method: string, params: unknown): Promise<any> {
    if (this.#failed) return Promise.reject(new Error("tsgo LSP is not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  #notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  /** Force the project tree to load. Without this workspace/symbol returns []. */
  openFile(absPath: string): void {
    this.syncFile(absPath);
    this.#openedProject = true;
  }

  /** Keep the LSP's open-file text aligned with disk before point queries. */
  syncFile(absPath: string): void {
    const uri = pathToFileURL(absPath).href;
    const text = fs.readFileSync(absPath, "utf8");
    if (!this.#opened.has(absPath)) {
      this.#notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: absPath.endsWith(".tsx") ? "typescriptreact" : "typescript",
          version: 1,
          text,
        },
      });
      this.#versions.set(absPath, 1);
      this.#opened.add(absPath);
      this.#openedProject = true;
      return;
    }

    const version = (this.#versions.get(absPath) ?? 1) + 1;
    this.#versions.set(absPath, version);
    this.#notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  get hasOpenProject(): boolean {
    return this.#openedProject;
  }

  async workspaceSymbol(query: string): Promise<LspSymbolResult> {
    const res = await this.#request("workspace/symbol", { query });
    const items = Array.isArray(res) ? res : (res?.symbols ?? []);
    return {
      symbols: items.map((s: any) => ({
        name: s.name,
        kind: s.kind,
        container: s.containerName ?? "",
        uri: s.location?.uri ?? s.location?.targetUri ?? "",
      })),
      truncated: items.length >= RESULT_CAP,
    };
  }

  /**
   * Flattened document symbols for one file — the LSP's navbar.
   *
   * Separate from workspaceSymbol because it reaches things the project-wide
   * index does not. Measured on 7.0.2 against an object literal of RPC
   * handlers:
   *
   *   workspace/symbol "Handler"   -> 1 hit  (the `rpcHandlers` binding only)
   *   documentSymbol               -> 10     (incl. getUserProfile,
   *                                           deleteAccount, innerHandler)
   *
   * Object-literal property keys are invisible to the project-wide index in
   * both backends, which is the entire reason ts_navigate_to takes a `file`
   * hint: handler maps and route tables are normally written that way.
   *
   * tsgo answers with FLAT SymbolInformation — `location` plus `containerName`,
   * no `children`. The hierarchical DocumentSymbol shape is walked too, since
   * the LSP spec permits either and the choice is the server's.
   */
  async documentSymbol(absPath: string): Promise<LspSymbol[]> {
    this.syncFile(absPath);
    const uri = pathToFileURL(absPath).href;
    const res = await this.#request("textDocument/documentSymbol", {
      textDocument: { uri },
    });

    const out: LspSymbol[] = [];
    const walk = (nodes: any[], container: string): void => {
      for (const n of nodes ?? []) {
        if (!n?.name) continue;
        // SymbolInformation nests it under `location`; DocumentSymbol does not.
        const start = (n.location?.range ?? n.selectionRange ?? n.range)?.start;
        out.push({
          name: n.name,
          kind: n.kind ?? 0,
          container: n.containerName ?? container,
          uri: n.location?.uri ?? uri,
          // LSP positions are 0-based; every other tool here reports 1-based.
          ...(start ? { line: start.line + 1, column: start.character + 1 } : {}),
        });
        if (Array.isArray(n.children)) {
          walk(n.children, container ? `${container}.${n.name}` : n.name);
        }
      }
    };
    walk(Array.isArray(res) ? res : [], "");
    return out;
  }

  async hover(absPath: string, pos: LspPosition): Promise<LspHover | null> {
    this.syncFile(absPath);
    const res = await this.#request("textDocument/hover", {
      textDocument: { uri: pathToFileURL(absPath).href },
      position: toLspPosition(pos),
    });
    if (!res?.contents) return null;
    return {
      ...normalizeHoverContents(res.contents),
      ...(res.range ? { range: fromLspRange(res.range) } : {}),
      source: "@effect/tsgo-lsp",
    };
  }

  async codeActions(args: {
    absPath: string;
    range: LspRange;
    diagnostics?: LspDiagnostic[];
    only?: string[];
  }): Promise<LspCodeAction[]> {
    this.syncFile(args.absPath);
    const res = await this.#request("textDocument/codeAction", {
      textDocument: { uri: pathToFileURL(args.absPath).href },
      range: toLspRange(args.range),
      context: {
        diagnostics: (args.diagnostics ?? []).map(denormalizeDiagnostic),
        ...(args.only ? { only: args.only } : {}),
      },
    });

    return (Array.isArray(res) ? res : [])
      .filter((action) => action?.title)
      .map((action) => ({
        title: String(action.title),
        ...(action.kind ? { kind: String(action.kind) } : {}),
        ...(action.isPreferred !== undefined ? { isPreferred: Boolean(action.isPreferred) } : {}),
        ...(Array.isArray(action.diagnostics)
          ? { diagnostics: action.diagnostics.map(normalizeDiagnostic) }
          : {}),
        ...(action.edit ? { edit: normalizeWorkspaceEdit(action.edit) } : {}),
        ...(action.command ? { command: action.command } : {}),
      }));
  }

  async stop(): Promise<void> {
    const proc = this.#proc;
    const closed = this.#closed;
    if (!proc || !closed) return;

    let exitNotified = false;
    if (!this.#failed && proc.exitCode === null && proc.signalCode === null) {
      const shutdown = this.#request("shutdown", null);
      if (await resolvesWithin(shutdown, 1_000)) {
        try {
          this.#notify("exit", null);
          exitNotified = true;
        } catch {
          /* child closed after the shutdown response */
        }
      }
    }

    // The LSP protocol asks the server to terminate after the exit notification.
    // Await its close event so callers can safely remove the project directory on
    // Windows, where a live child retains a handle on its cwd. A broken server is
    // still bounded: terminate after the grace period and wait once more.
    const closedGracefully = exitNotified && (await resolvesWithin(closed, 1_000));
    if (!closedGracefully) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await resolvesWithin(closed, 1_000);
    }
    this.#proc = undefined;
    this.#closed = undefined;
  }
}

async function resolvesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
