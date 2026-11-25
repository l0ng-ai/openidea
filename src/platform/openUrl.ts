import { isTauri } from "./ipc";

const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Plugins and rendered content reach this with arbitrary strings: never hand `file:` or app-launching schemes to the OS. */
export function isOpenable(url: string): boolean {
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

/**
 * A middle click on a link (`auxclick`) would have the webview open it in a new window or
 * navigate this window away from the IDE. A web link opens in the default browser instead,
 * as a left click on it does; any other link does nothing.
 */
export function installMiddleClickLinks(target: Document = document): () => void {
  const onAuxClick = (e: MouseEvent) => {
    if (e.button !== 1 || e.defaultPrevented) return;
    const link = (e.target as Element | null)?.closest?.("a[href]");
    if (!(link instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    const url = new URL(link.href, location.href);
    if (/^https?:$/.test(url.protocol) && url.origin !== location.origin) void openExternalUrl(url.href);
  };
  target.addEventListener("auxclick", onAuxClick);
  return () => target.removeEventListener("auxclick", onAuxClick);
}
