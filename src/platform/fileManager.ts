import type { RemoteTarget } from "./ipc";
import { call, commands, isTauri } from "./ipc";
import { usePlatform } from "./platformInfo";
import { useRemote } from "./remote";

function wslSharePath(path: string, target: RemoteTarget | null): string {
  if (target?.kind !== "wsl" || !path.startsWith("/")) return path;
  return `\\\\wsl.localhost\\${target.distro}${path.replaceAll("/", "\\")}`;
}

function windowTarget(): RemoteTarget | null {
  return useRemote.getState().session?.target ?? null;
}

/**
 * A path in the form the local OS file manager's Shell APIs accept. Project
 * paths use `/` separators and may be Windows verbatim paths, but Explorer's
 * `ILCreateFromPathW` rejects `\\?\UNC\...`.
 */
export function fileManagerPath(path: string, os = usePlatform.getState().os, target = windowTarget()): string {
  if (os !== "windows") return path;
  path = wslSharePath(path, target);
  if (/^\/\/\?\/unc\//i.test(path)) path = `\\\\${path.slice(8).replaceAll("/", "\\")}`;
  else if (path.startsWith("//?/")) path = path.slice(4);
  if (/^\\\\\?\\unc\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  if (path.startsWith("//")) return path.replaceAll("/", "\\");
  if (/^[A-Za-z]:\//.test(path)) return path.replaceAll("/", "\\");
  return path;
}

/** English source text; callers and the action registry translate it. */
export function fileManagerName(os = usePlatform.getState().os): string {
  return os === "macos" ? "Finder" : os === "windows" ? "Explorer" : "Files";
}

export function showInFileManagerLabel(os = usePlatform.getState().os): string {
  return os === "macos" ? "Show in Finder" : os === "windows" ? "Show in Explorer" : "Show in Files";
}

/** The project action has historically used "Reveal" on macOS. */
export function revealInFileManagerLabel(os = usePlatform.getState().os): string {
  return os === "macos" ? "Reveal in Finder" : showInFileManagerLabel(os);
}

/**
 * Whether this desktop's file manager can show paths of `target` (default: this window's; `null`: this
 * desktop's own). SSH and dev-container paths exist only on the server; WSL ones are reachable on
 * Windows through their `\\wsl.localhost` share.
 */
export function canRevealInFileManager(target = windowTarget(), os = usePlatform.getState().os): boolean {
  return target === null || (target.kind === "wsl" && os === "windows");
}

/**
 * Reveals files in Explorer, Finder or the Linux desktop's file manager. `target` says where the paths
 * live (default: this window's project host); `false` when this desktop cannot show them.
 */
export async function revealInFileManager(
  paths: string | readonly string[],
  target = windowTarget(),
): Promise<boolean> {
  if (!isTauri() || !canRevealInFileManager(target)) return false;
  const list = (typeof paths === "string" ? [paths] : paths).map((path) => fileManagerPath(path, undefined, target));
  if (!list.length) return false;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(list.length === 1 ? list[0]! : [...list]);
  return true;
}

/**
 * Whether this desktop can launch files of `target` (default: this window's). Only this desktop's own
 * projects qualify: the backend refuses remote windows (SSH, dev container, WSL), whose files live on
 * their server.
 */
export function canOpenWithSystemApp(target = windowTarget()): boolean {
  return isTauri() && target === null;
}

/**
 * Launches `path` with its associated application. The backend checks that the window is trusted and
 * that the file lies inside its project. False when this desktop cannot, or the launch was refused.
 */
export async function openWithSystemApp(path: string, target = windowTarget()): Promise<boolean> {
  if (!canOpenWithSystemApp(target)) return false;
  try {
    await call(commands.fsOpenWithSystem(path));
    return true;
  } catch (e) {
    console.warn(`cannot open ${path} with its application`, e);
    return false;
  }
}
