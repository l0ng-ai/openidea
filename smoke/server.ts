/**
 * `openidea-server --stdio`, spoken to as the desktop app does in remote development:
 * JSON-RPC with `Content-Length` framing over the server's stdin / stdout.
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROTOCOL_VERSION = 2;
const WINDOW = "main";

// Not `new URL(…, import.meta.url)`: the jsdom environment's `URL` isn't Node's.
export const repoRoot = join(dirname(import.meta.filename), "..");

/** The server binary: `OPENIDEA_SERVER`, else the workspace's debug build. */
function serverBinary(): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  return process.env.OPENIDEA_SERVER ?? join(repoRoot, "target", "debug", `openidea-server${exe}`);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** `taskkill /T /F`: the tree rooted at `pid` (see `Server.close`). Always resolves. */
function treeKill(pid: number | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (pid === undefined) return resolve();
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve());
  });
}

/** Resolves once no process group `pid` exists anymore (signal 0 only checks). */
async function waitForGroupExit(pid: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export class Server {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private readonly stderr: string[] = [];
  /** `channel` notifications: a value streamed to the `Channel` with this id. */
  onChannel: (id: number, data: unknown) => void = () => {};
  /** `event` notifications: an `IdeEvent` for a window (`null`: every window). */
  onEvent: (window: string | null, event: unknown) => void = () => {};

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      // The whole log, when asked for (OPENIDEA_SMOKE_LOG=<file>; OPENIDEA_LOG sets its level).
      if (process.env.OPENIDEA_SMOKE_LOG) appendFileSync(process.env.OPENIDEA_SMOKE_LOG, chunk);
      this.stderr.push(chunk.toString());
      if (this.stderr.length > 200) this.stderr.shift();
    });
    child.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`openidea-server exited (${code}): ${this.log()}`));
      this.pending.clear();
    });
  }

  /** Starts a server whose settings, caches and tools live under `home`. */
  static async start(home: string, env: Record<string, string> = {}): Promise<Server> {
    const child = spawn(serverBinary(), ["--stdio"], {
      env: { ...process.env, OPENIDEA_SERVER_HOME: home, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group: the language servers it starts (jdtls's JVM) stay in
      // it, so `close` can reap them together with the server (see below).
      detached: true,
    });
    const server = new Server(child);
    await server.request("initialize", { version: PROTOCOL_VERSION });
    return server;
  }

  /** The tail of the server's log, for failure messages. */
  log(): string {
    return this.stderr.join("").split("\n").slice(-40).join("\n");
  }

  /** Runs an IPC command; rejects with the command's `IdeError`. */
  async invoke(cmd: string, args: unknown): Promise<unknown> {
    try {
      return await this.request("invoke", { window: WINDOW, cmd, args });
    } catch (e) {
      const message = (e as { message?: string }).message ?? String(e);
      try {
        throw JSON.parse(message);
      } catch (parsed) {
        if (parsed instanceof SyntaxError) throw { kind: "protocol", message, detail: null };
        throw parsed;
      }
    }
  }

  /**
   * Kills the server and everything it started; resolves once they're all gone.
   * The server alone is not enough: a language server's own process (jdtls's JVM)
   * outlives it and keeps writing under the test's home directory, so deleting that
   * directory afterwards raced its writes (`ENOTEMPTY` on teardown). The server runs
   * detached (its own process group), so the group is only it and its children.
   */
  async close(): Promise<void> {
    if (this.child.exitCode === null && !this.child.killed) {
      const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
      this.child.stdin.end();
      if (process.platform === "win32") {
        // `child.kill()` stops only the server; take the whole tree while it is
        // still enumerable, then wait for the exit below.
        await treeKill(this.child.pid);
      } else {
        this.child.kill();
      }
      await exited;
    }
    if (process.platform !== "win32" && this.child.pid !== undefined) {
      // Reap what the server started: `SIGKILL` to the group, then wait until it is
      // gone (termination is asynchronous; files held open can't be deleted meanwhile).
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {
        // Nothing left running.
      }
      await waitForGroupExit(this.child.pid);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(message: unknown) {
    const body = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = /content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1];
      if (!length) throw new Error(`bad header: ${this.buffer.subarray(0, end)}`);
      const start = end + 4;
      if (this.buffer.length < start + Number(length)) return;
      const message = JSON.parse(this.buffer.subarray(start, start + Number(length)).toString());
      this.buffer = this.buffer.subarray(start + Number(length));
      this.dispatch(message);
    }
  }

  private dispatch(message: {
    id?: number;
    method?: string;
    params?: { id?: number; data?: unknown; window?: string | null; event?: unknown };
    result?: unknown;
    error?: { message: string };
  }) {
    if (message.method && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported" } });
    } else if (message.method === "channel") {
      this.onChannel(message.params!.id!, message.params!.data);
    } else if (message.method === "event") {
      this.onEvent(message.params!.window ?? null, message.params!.event);
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(message.error);
      else pending?.resolve(message.result);
    }
  }
}
