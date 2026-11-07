/**
 * `openidea-server --stdio`, spoken to as the desktop app does in remote development:
 * JSON-RPC with `Content-Length` framing over the server's stdin / stdout.
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROTOCOL_VERSION = 2;
const WINDOW = "main";
// The server allows host.shutdown() ten seconds after EOF.
const SHUTDOWN_TIMEOUT_MS = 15_000;

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
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: 5000 }, () => resolve());
  });
}

/** Wait for both a group and its leader to disappear (signal 0 only checks). */
async function waitForGroupExit(pid: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const alive = [pid, -pid].some((target) => {
      try {
        process.kill(target, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive || Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface ProcessInfo {
  pid: number;
  parent: number;
  group: number;
  started: string;
}

function processTable(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], { timeout: 1000 }, (error, stdout) => {
      if (error) return resolve([]);
      const rows: ProcessInfo[] = [];
      for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (match)
          rows.push({ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[4]! });
      }
      resolve(rows);
    });
  });
}

/** Snapshot owned group members before EOF can orphan them. */
async function ownedProcesses(pid: number): Promise<ProcessInfo[]> {
  const rows = await processTable();
  const descendants = new Set([pid]);
  for (;;) {
    const size = descendants.size;
    for (const row of rows) {
      if (descendants.has(row.parent)) descendants.add(row.pid);
    }
    if (size === descendants.size) break;
  }
  return rows.filter((row) => descendants.has(row.pid) && descendants.has(row.group));
}

/** Revalidate identities so a group id reused during shutdown is never signalled. */
async function killOwnedGroups(owned: ProcessInfo[]): Promise<number[]> {
  const current = await processTable();
  const groups = new Set<number>();
  for (const row of current) {
    if (owned.some((old) => old.pid === row.pid && old.group === row.group && old.started === row.started)) {
      groups.add(row.group);
    }
  }
  for (const group of groups) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      /* Already gone. */
    }
  }
  return [...groups];
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

  private closing: Promise<void> | undefined;
  private readonly child: ChildProcessWithoutNullStreams;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      // The whole log, when asked for (OPENIDEA_SMOKE_LOG=<file>; OPENIDEA_LOG sets its level).
      if (process.env.OPENIDEA_SMOKE_LOG) appendFileSync(process.env.OPENIDEA_SMOKE_LOG, chunk);
      this.stderr.push(chunk.toString());
      if (this.stderr.length > 200) this.stderr.shift();
    });
    child.on("error", (error) => {
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    });
    // A process exiting during a request can close its stdin before the exit event.
    child.stdin.on("error", (error) => {
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
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
      // A dedicated group for forced cleanup; LSPs may create groups of their own.
      detached: true,
    });
    const server = new Server(child);
    try {
      await server.request("initialize", { version: PROTOCOL_VERSION });
      return server;
    } catch (error) {
      await server.close();
      throw error;
    }
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

  /** Let EOF shut down and reap tools before falling back to forced cleanup. */
  close(): Promise<void> {
    return (this.closing ??= this.shutdown());
  }

  private async shutdown(): Promise<void> {
    const pid = this.child.pid;
    const owned = process.platform !== "win32" && pid !== undefined ? await ownedProcesses(pid) : [];
    const killedGroups = new Set<number>();
    const running = () => pid !== undefined && this.child.exitCode === null && this.child.signalCode === null;
    if (running()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
      this.child.stdin.end();
      try {
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (running()) {
        if (process.platform === "win32") {
          // Enumerate the tree while its root is still alive.
          await treeKill(pid);
        } else {
          if (pid !== undefined) owned.push(...(await ownedProcesses(pid)));
          for (const group of await killOwnedGroups(owned)) killedGroups.add(group);
        }
        // The ChildProcess handle still owns this PID if group discovery failed.
        if (running()) this.child.kill("SIGKILL");
        await exited;
      }
    }
    if (process.platform !== "win32") {
      for (const group of await killOwnedGroups(owned)) killedGroups.add(group);
    }
    await Promise.all([...killedGroups].map((group) => waitForGroupExit(group)));
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
