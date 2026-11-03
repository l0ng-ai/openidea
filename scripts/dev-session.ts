import { realpathSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";

export const worktreeRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

export function worktreeId(root: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(root)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `ai.l0ng.openidea.dev.w${hash.toString(16).padStart(16, "0")}`;
}

export interface DevSession {
  worktree: string;
  identifier: string;
  pid: number;
  devUrl?: string;
}

export function preferredVitePort(identifier: string): number {
  return 15000 + (Number.parseInt(identifier.slice(-8), 16) % 20000);
}

function readSession(port: number): Promise<DevSession | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let data = "";
    const finish = (session?: DevSession) => {
      socket.destroy();
      resolve(session);
    };
    socket.setTimeout(1000, () => finish());
    socket.on("error", () => finish());
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 16384) finish();
    });
    socket.on("end", () => {
      try {
        finish(JSON.parse(data));
      } catch {
        finish();
      }
    });
  });
}

// A live OS listener is the lock: no stale PID files after crashes or PID reuse.
export async function claimSession(
  session: DevSession,
  firstPort = 43000 + (Number.parseInt(session.identifier.slice(-8), 16) % 10000),
): Promise<{ server: Server } | { existing: DevSession }> {
  for (let offset = 0; offset < 100; offset++) {
    const port = firstPort + offset;
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.end(JSON.stringify(session));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      return { server };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      const existing = await readSession(port);
      if (existing?.worktree === session.worktree && existing.identifier === session.identifier) {
        return { existing };
      }
    }
  }
  throw new Error("No available development session port");
}

export function withDevConfig(args: string[], devUrl: string): string[] {
  const separator = args.indexOf("--");
  const index = separator < 0 ? args.length : separator;
  return [
    ...args.slice(0, index),
    "--config",
    JSON.stringify({ build: { beforeDevCommand: "", devUrl } }),
    ...args.slice(index),
  ];
}
