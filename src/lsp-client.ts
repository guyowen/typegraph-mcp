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
import { pathToFileURL } from "node:url";

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

export class LspClient {
  #proc: ChildProcess | undefined;
  #buf = Buffer.alloc(0);
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #nextId = 1;
  #openedProject = false;
  #opened = new Set<string>();

  readonly exePath: string;
  readonly rootDir: string;

  constructor(exePath: string, rootDir: string) {
    this.exePath = exePath;
    this.rootDir = rootDir;
  }

  async start(): Promise<void> {
    this.#proc = spawn(this.exePath, ["--lsp", "-stdio"], {
      cwd: this.rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  /** Force the project tree to load. Without this workspace/symbol returns []. */
  openFile(absPath: string): void {
    this.#notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(absPath).href,
        languageId: "typescript",
        version: 1,
        text: fs.readFileSync(absPath, "utf8"),
      },
    });
    this.#openedProject = true;
    this.#opened.add(absPath);
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
    if (!this.#opened.has(absPath)) this.openFile(absPath);
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

  async stop(): Promise<void> {
    try {
      await this.#request("shutdown", null);
      this.#notify("exit", null);
    } catch {
      /* shutting down anyway */
    }
    this.#proc?.kill();
    this.#proc = undefined;
  }
}
