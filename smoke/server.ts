/**
 * `openidea-server --stdio`, spoken to as the desktop app does in remote development:
 * JSON-RPC with `Content-Length` framing over the server's stdin / stdout.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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

  close() {
    this.child.stdin.end();
    this.child.kill();
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
