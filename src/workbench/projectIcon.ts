/**
 * IDEA's custom project icon: an image in the project's config folder shown instead of the
 * coloured initials (title bar project widget, Welcome screen and recent project lists).
 * Read from `.openidea/` (Change Project Icon… writes there) and then from IntelliJ's `.idea/`,
 * `icon_dark.*` first in a dark theme; SVG before PNG.
 */
import { useEffect, useSyncExternalStore } from "react";
import { call, commands } from "@/platform/ipc";
import { parseRemoteLocation } from "@/platform/remote";
import { subscribeTheme } from "@/platform/themeWatch";

const FOLDERS = [".openidea", ".idea"];
export const PROJECT_ICON_EXTENSIONS = ["svg", "png"] as const;

/** `root/parts…`, with the separator `root` uses (a Windows path keeps its backslashes). */
function childPath(root: string, ...parts: string[]): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

const dark = () => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";

/** The files that may hold `root`'s icon, most preferred first. */
export function projectIconCandidates(root: string, darkTheme: boolean): string[] {
  const names = PROJECT_ICON_EXTENSIONS.flatMap((ext) => [...(darkTheme ? [`icon_dark.${ext}`] : []), `icon.${ext}`]);
  return FOLDERS.flatMap((folder) => names.map((name) => childPath(root, folder, name)));
}

/** Per `root|theme`: the icon's data URL and file; `undefined` while it loads, `null` without one. */
const icons = new Map<string, { url: string; path: string } | null | undefined>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const offTheme = subscribeTheme(listener);
  return () => {
    listeners.delete(listener);
    offTheme();
  };
}

async function load(root: string, darkTheme: boolean, key: string) {
  for (const path of projectIconCandidates(root, darkTheme)) {
    // oxlint-disable-next-line no-await-in-loop -- candidates are ordered by preference; the first readable icon wins
    const url = await call(commands.fsReadImage(path)).catch(() => null);
    if (url) {
      icons.set(key, { url, path });
      emit();
      return;
    }
  }
  icons.set(key, null);
  emit();
}

/** `root`'s icon if it has one (a data URL), else null; loads on first use. */
export function useProjectIcon(root: string | null | undefined): string | null {
  useSyncExternalStore(subscribe, () => version);
  const local = !!root && !parseRemoteLocation(root);
  const key = `${root}|${dark() ? "dark" : "light"}`;
  const known = local ? icons.get(key) : null;
  // Not looked up yet, or dropped by a change: (re)load it.
  const unknown = local && !icons.has(key);
  useEffect(() => {
    if (!unknown || icons.has(key)) return;
    icons.set(key, undefined);
    void load(root!, key.endsWith("|dark"), key);
  }, [unknown, root, key]);
  return known?.url ?? null;
}

/** Whether `root` shows an icon set by Change Project Icon… (which Reset Project Icon removes). */
export function hasCustomProjectIcon(root: string): boolean {
  const own = childPath(root, ".openidea", "");
  return [...icons].some(([key, icon]) => key.startsWith(`${root}|`) && !!icon?.path.startsWith(own));
}

/**
 * Change Project Icon…: copies `file` (SVG or PNG) to `.openidea/icon.<ext>` in `root`, replacing
 * the icon set there before; `null` removes it (Reset Project Icon).
 */
export async function setProjectIcon(root: string, file: string | null): Promise<void> {
  const ext = file?.toLowerCase().split(".").pop();
  if (file && !PROJECT_ICON_EXTENSIONS.includes(ext as (typeof PROJECT_ICON_EXTENSIONS)[number]))
    throw new Error("A project icon is an SVG or PNG image");
  await Promise.all(
    PROJECT_ICON_EXTENSIONS.flatMap((e) => [`icon.${e}`, `icon_dark.${e}`]).map((name) =>
      call(commands.fsDelete(childPath(root, ".openidea", name))).catch(() => undefined),
    ),
  );
  if (file) await call(commands.fsCopy(file, childPath(root, ".openidea", `icon.${ext}`)));
  for (const key of [...icons.keys()]) if (key.startsWith(`${root}|`)) icons.delete(key);
  emit();
}
