import { isTauri } from "./ipc";

const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Plugins and rendered content reach this with arbitrary strings: never hand `file:` or app-launching schemes to the OS. */
function isOpenable(url: string): boolean {
  if (url !== url.trim()) return false;
  try {
    return OPENABLE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Opens a web or `mailto:` URL with the system handler (the default browser); other schemes are ignored. */
export async function openExternalUrl(url: string): Promise<void> {
  if (!isOpenable(url)) return;
  if (!isTauri()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
