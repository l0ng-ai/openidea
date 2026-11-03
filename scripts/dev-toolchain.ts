import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Tauri's host detection unwraps a missing `host:` line, hiding rustc's actual error. */
export function rustHost(output: string): string {
  const host = /^host:[ \t]*(\S+)[ \t]*\r?$/m.exec(output)?.[1];
  if (!host)
    throw new Error("rustc -vV returned no host target. Check the selected Rust toolchain and available memory.");
  return host;
}

/** Run before loading Vite, so toolchain startup failures retain their diagnostics. */
export async function checkRustToolchain(): Promise<void> {
  try {
    const { stdout } = await execute("rustc", ["-vV"], { windowsHide: true, timeout: 30_000 });
    rustHost(stdout);
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(
      `Cannot start the Rust toolchain (rustc -vV).\n${failure.stderr?.trim() || failure.message}\n` +
        "If this reports an allocation failure, save your work and close unused memory-heavy applications before retrying.",
      { cause: error },
    );
  }
}

/** Keep desktop dev builds small; explicit Cargo arguments after these defaults win. */
export function withDevBuildDefaults(args: string[]): string[] {
  const separator = args.indexOf("--");
  const cli = separator < 0 ? args : args.slice(0, separator);
  const runner = separator < 0 ? [] : args.slice(separator + 1);
  const appSeparator = runner.indexOf("--");
  const cargo = appSeparator < 0 ? runner : runner.slice(0, appSeparator);
  const jobs = cargo.some((arg) => arg === "--jobs" || arg.startsWith("--jobs=") || /^-j(?:\d+)?$/.test(arg));
  return [...cli, "--", ...(jobs ? [] : ["-j", "1"]), "--config", "profile.dev.package.openidea.debug=0", ...runner];
}
