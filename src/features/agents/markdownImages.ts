import { call, commands } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import { tx } from "@/platform/i18n";

const hasControl = (text: string) => [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

type ImageTarget = { url: string } | { path: string };

/** Images name host files, not paths relative to the webview's own origin. */
export function imageTarget(source: string, cwd: string): ImageTarget | null {
  const src = source.trim();
  if (!src || hasControl(src)) return null;
  if (/^data:image\//i.test(src)) return { url: src };
  try {
    if (/^https?:\/\//i.test(src) || src.startsWith("//")) {
      const url = src.startsWith("//") ? `https:${src}` : src;
      new URL(url);
      return { url };
    }
    let path: string;
    if (/^file:/i.test(src)) {
      const url = new URL(src);
      path = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
      if (url.hostname && url.hostname !== "localhost") path = `//${url.hostname}${path}`;
    } else {
      if (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return null;
      path = ipcPath(decodeURIComponent(src.split(/[?#]/, 1)[0]!));
    }
    if (!path || hasControl(path)) return null;
    if (path.startsWith("/") || /^[a-z]:\//i.test(path)) return { path };
    const base = ipcPath(cwd).replace(/\/$/, "");
    if (/^[a-z]:\//i.test(base) || base.startsWith("//")) path = path.replace(/\\/g, "/");
    return { path: `${base}/${path}` };
  } catch {
    return null;
  }
}

/** Cache belongs to one message: streaming reuses reads, later replies can show a new QR at the same path. */
export function loadImages(root: HTMLElement, cwd: string, cache: Map<string, Promise<string>>): () => void {
  let alive = true;
  const images = [...root.querySelectorAll<HTMLImageElement>("img")];
  for (const img of images) {
    const source = img.dataset.imageSrc ?? "";
    const fail = () => {
      if (!alive) return;
      img.onerror = null;
      img.removeAttribute("src");
      img.alt = tx`Unable to load image: ${source}`;
    };
    img.setAttribute("referrerpolicy", "no-referrer");
    img.onerror = fail;
    const target = imageTarget(source, cwd);
    if (!target) {
      fail();
    } else if ("url" in target) {
      img.src = target.url;
    } else {
      let pending = cache.get(target.path);
      if (!pending) {
        pending = call(commands.fsReadImage(target.path));
        cache.set(target.path, pending);
        void pending.catch(() => cache.delete(target.path));
      }
      void pending.then((url) => {
        if (alive) img.src = url;
      }, fail);
    }
  }
  return () => {
    alive = false;
    for (const img of images) img.onerror = null;
  };
}
