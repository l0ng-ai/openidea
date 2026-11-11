import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { claimSession, preferredVitePort, withDevConfig, worktreeId, worktreeRoot } from "./dev-session.ts";
import type { DevSession } from "./dev-session.ts";

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");

function stopChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function runCli(args: string[]): Promise<number> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: worktreeRoot,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopChild(child, "SIGTERM");
    timer ??= setTimeout(() => stopChild(child, "SIGKILL"), 5000);
    timer.unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    if (timer) clearTimeout(timer);
    stopChild(child, "SIGTERM");
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] !== "dev" || args.includes("--help") || args.includes("-h") || args.includes("--release")) {
    return runCli(args);
  }
  const session: DevSession = {
    worktree: worktreeRoot,
    identifier: worktreeId(worktreeRoot),
    pid: process.pid,
  };
  const claim = await claimSession(session);
  if ("existing" in claim) {
    console.log("Development session already running for this worktree:");
    console.log(JSON.stringify(claim.existing, null, 2));
    console.log("Use pnpm dev:status to find its MCP port.");
    return 0;
  }
  let vite: import("vite").ViteDevServer | undefined;
  try {
    const { createServer } = await import("vite");
    vite = await createServer({
      root: worktreeRoot,
      server: { port: preferredVitePort(session.identifier), strictPort: false },
    });
    await vite.listen();
    session.devUrl = vite.resolvedUrls?.local[0] ?? vite.resolvedUrls?.network[0];
    if (!session.devUrl) throw new Error("Vite did not expose a development URL");
    console.log(JSON.stringify(session, null, 2));
    console.log("Use pnpm dev:status after the app starts to find its MCP port.");
    return await runCli(withDevConfig(args, session.devUrl));
  } finally {
    await vite?.close();
    claim.server.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
