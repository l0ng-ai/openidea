/// <reference lib="es2024.promise" />
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

/** Run one owned command and bound both execution and process-tree cleanup. */
export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    label?: string;
    graceMs?: number;
    stdio?: StdioOptions;
  },
): Promise<void> {
  const label = options.label ?? command;
  const graceMs = options.graceMs ?? 1000;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647) {
    throw new Error(`${label}: invalid execution deadline`);
  }
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > 2_147_483_647) {
    throw new Error(`${label}: invalid cleanup deadline`);
  }
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    stdio: options.stdio ?? "inherit",
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const errors: string[] = [];
  let stopping = false;
  let finished = false;
  let cleanup: NodeJS.Timeout | undefined;
  let treeKiller: ChildProcess | undefined;
  const group = process.platform !== "win32";
  const alive = () => {
    if (!child.pid) return false;
    try {
      process.kill(group ? -child.pid : child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  const signal = (value: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (group) process.kill(-child.pid, value);
      else child.kill(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        errors.push(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    clearTimeout(cleanup);
    treeKiller?.kill("SIGKILL");
    treeKiller?.unref();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    // Never wait indefinitely for an uninterruptible process or inherited pipe.
    child.unref();
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (errors.length) reject(new Error(`${label}: ${errors.join("; ")}`));
    else resolve();
  };
  const stop = (error?: string) => {
    if (error) errors.push(error);
    if (stopping) return;
    stopping = true;
    clearTimeout(deadline);
    if (!alive()) return finish();
    if (!group && child.pid) {
      // Windows has no POSIX process groups. Bound this PID-scoped taskkill too.
      treeKiller = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      treeKiller.on("error", (failure) => errors.push(`tree cleanup: ${failure.message}`));
    } else signal("SIGTERM");
    cleanup = setTimeout(() => {
      signal("SIGKILL");
      cleanup = setTimeout(() => {
        if (alive()) errors.push("process group remained after SIGKILL");
        finish();
      }, graceMs);
    }, graceMs);
  };
  const interrupt = () => stop("interrupted by SIGINT");
  const terminate = () => stop("interrupted by SIGTERM");
  const deadline = setTimeout(() => stop(`timed out after ${options.timeoutMs} ms`), options.timeoutMs);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  child.once("error", (error) => stop(`spawn failed: ${error.message}`));
  child.once("exit", (code, exitSignal) => {
    if (code !== 0 && !errors.length) errors.push(`failed (exit ${code}, signal ${exitSignal})`);
    if (!stopping) stop();
    else if (!alive()) finish();
  });
  return promise;
}
