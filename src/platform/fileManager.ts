import type { RemoteSession } from "./ipc";
import { isTauri } from "./ipc";
import { usePlatform } from "./platformInfo";
import { useRemote } from "./remote";

function wslSharePath(path: string, session: RemoteSession | null): string {
  if (session?.target.kind !== "wsl" || !path.startsWith("/")) return path;
  return `\\\\wsl.localhost\\${session.target.distro}${path.replaceAll("/", "\\")}`;
}

/**
 * A path in the form the local OS file manager's Shell APIs accept. Project
 * paths use `/` separators and may be Windows verbatim paths, but Explorer's
 * `ILCreateFromPathW` rejects `\\?\UNC\...`.
 */
export function fileManagerPath(
  path: string,
  os = usePlatform.getState().os,
  session = useRemote.getState().session,
): string {
  if (os !== "windows") return path;
  path = wslSharePath(path, session);
  if (/^\/\/\?\/unc\//i.test(path)) path = `\\\\${path.slice(8).replaceAll("/", "\\")}`;
  else if (path.startsWith("//?/")) path = path.slice(4);
  if (/^\\\\\?\\unc\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  if (path.startsWith("//")) return path.replaceAll("/", "\\");
  if (/^[A-Za-z]:\//.test(path)) return path.replaceAll("/", "\\");
  return path;
}

/** Reveals files in Explorer, Finder or the Linux desktop's file manager. */
export async function revealInFileManager(paths: string | readonly string[]): Promise<void> {
  if (!isTauri()) return;
  const list = (typeof paths === "string" ? [paths] : paths).map((path) => fileManagerPath(path));
  if (!list.length) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(list.length === 1 ? list[0]! : [...list]);
}
