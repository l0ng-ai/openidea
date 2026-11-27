/**
 * The home folder `~` stands for in terminal links: the home of the machine the
 * terminal's shell runs on. In a remote window (SSH, WSL, dev container) that is
 * the remote user's home, never this desktop's.
 */
import { commands, isTauri } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";

let cached: { key: object; home: Promise<string | null> } | null = null;
const LOCAL = {};

/** `~`, `~/…` or `~\…`. */
export function isHomePath(path: string): boolean {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\");
}

async function localHome(): Promise<string> {
  const { homeDir } = await import("@tauri-apps/api/path");
  return homeDir();
}

/** `$HOME` (else `%USERPROFILE%`) of the project host, which serves `run_system_env` in a remote window. */
async function remoteHome(): Promise<string | null> {
  const env = await commands.runSystemEnv();
  return env.HOME || env.USERPROFILE || null;
}

/** The home folder for `~` in this window's terminals; `null` while it can't be read. */
export function terminalHome(): Promise<string | null> {
  if (!isTauri()) return Promise.resolve(null);
  const session = useRemote.getState().session;
  // Per remote session: a reconnect, or another container behind the same host name, reads it again.
  const key = session ?? LOCAL;
  if (cached?.key === key) return cached.home;
  const home: Promise<string | null> = (session ? remoteHome() : localHome())
    .then((h) => h?.replace(/[\\/]+$/, "") || null)
    .catch(() => null)
    .then((h) => {
      // Not readable now: ask again next time.
      if (!h && cached?.home === home) cached = null;
      return h;
    });
  cached = { key, home };
  return home;
}

export function _resetTerminalHomeForTests() {
  cached = null;
}
