// ZCode Protocol stdio app-server client. Owns the child process, NDJSON
// framing, request/response correlation and the server-initiated interaction
// requests (runtime preferences, permissions, account auth headers, user
// questions).
//
// Wire format (one JSON object per line over stdio):
//   client -> server:  {"id": N, "method": "...", "params": {...}}
//   server -> client:  {"id": N, "result": {...}} | {"id": N, "error": {...}}
//   server request:    {"id": "server-N", "method": "...", "params": {...}}
//                      (answer with {"id": "server-N", "result": {...}})
//   notification:      {"method": "...", "params": {...}}
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export type ServerMessage = Record<string, any>;
export type MessageListener = (msg: ServerMessage) => void;

export interface InteractionHooks {
  runtimePreferences: () => unknown;
  permission: () => { decision: "allow" | "deny"; reason: string };
  providerRuntimeHeaders: (params: any) => Promise<unknown>;
  userInput: (msg: ServerMessage) => Promise<void>;
}

export interface AppServerOptions {
  command: string; // "bin arg arg..." — split on spaces
  env: NodeJS.ProcessEnv;
  hooks: InteractionHooks;
  onDown: (error: Error) => void;
  debug?: (line: string) => void;
}

export class AppServer {
  private proc: ChildProcess | null = null;
  private down = false;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<MessageListener>();
  private nextId = 1;
  private debug: (line: string) => void;
  private options: AppServerOptions;

  constructor(options: AppServerOptions) {
    this.options = options;
    this.debug = options.debug ?? (() => {});
  }

  get running(): boolean {
    return this.proc !== null;
  }

  /** Subscribe to every decoded server message (events + notifications). */
  on(listener: MessageListener): void {
    this.listeners.add(listener);
  }

  off(listener: MessageListener): void {
    this.listeners.delete(listener);
  }

  /** Answer a server-initiated request (interaction) outside the correlation map. */
  answerServerRequest(id: unknown, result: unknown): void {
    this.writeResult(id, result);
  }

  /** Send a request; resolves with `result` or rejects with `error.message`. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.ensureStarted();
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  /** Stop the process and reject every pending request. */
  kill(): void {
    this.proc?.kill();
    this.fail(new Error("app-server stopped by client"));
  }

  private ensureStarted(): void {
    if (this.proc) return;
    this.down = false;
    const [bin, ...args] = this.options.command.split(" ");
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: this.options.env,
    });
    this.proc = child;
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      this.debug(line);
      let msg: ServerMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id != null && msg.method == null) this.settle(msg);
      else if (msg.method != null) this.handleServerRequest(msg);
      for (const listener of this.listeners) listener(msg);
    });
    child.on("error", (e) => this.fail(new Error(`cannot start zcode app-server: ${e.message}`)));
    child.on("exit", (code) => this.fail(new Error(`zcode app-server exited (code ${code})`)));
  }

  private write(value: unknown): void {
    this.proc?.stdin?.write(JSON.stringify(value) + "\n");
  }

  private writeResult(id: unknown, result: unknown): void {
    this.write({ id, result });
  }

  private settle(msg: ServerMessage): void {
    const entry = this.pending.get(String(msg.id));
    if (!entry) return;
    this.pending.delete(String(msg.id));
    if (msg.error) entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  }

  private handleServerRequest(msg: ServerMessage): void {
    const hooks = this.options.hooks;
    switch (msg.method) {
      case "session/requestRuntimePreferences":
        this.writeResult(msg.id, hooks.runtimePreferences());
        break;
      case "interaction/requestPermission":
        this.writeResult(msg.id, hooks.permission());
        break;
      case "interaction/requestProviderRuntimeHeaders":
        void hooks
          .providerRuntimeHeaders(msg.params)
          .then(
            (result) => this.writeResult(msg.id, result),
            (error) =>
              this.writeResult(msg.id, {
                headersApplied: false,
                errorMessage: error instanceof Error ? error.message : String(error),
              }),
          );
        break;
      case "interaction/requestUserInput":
        void hooks.userInput(msg);
        break;
      default:
        break; // unsupported server request: ignore (never crash the bridge)
    }
  }

  private fail(error: Error): void {
    if (this.down) return;
    this.down = true;
    this.proc = null;
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
    this.options.onDown(error);
  }
}
