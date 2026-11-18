/** Installed browsers, the built-in server's URLs, and per-file preview state. */
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { hasFileType } from "@/platform/fileTypes";
import { call, commands, isTauri, type Browser } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { hasIcon } from "@/ui";
import { notifications } from "@/workbench/contributions";

/** A Django template is an HTML file the banner in `djangoTemplates.ts` retyped: it keeps the preview. */
const HTML_LANGUAGES = ["html", "django-html"];
const HTML_EXTENSIONS = new Set(["html", "htm", "xhtml", "shtml"]);

/** Files that get the browser bar and the built-in preview: HTML by Settings › File Types. */
export function isHtmlPath(path: string): boolean {
  const { settings, project } = useProject.getState();
  return hasFileType(path, HTML_LANGUAGES, HTML_EXTENSIONS, settings?.files, project?.root ?? null);
}

/** Files a browser can show (Open In › Browser). */
export const isWebPath = (path: string) => isHtmlPath(path) || /\.svg$/i.test(path);

export const useBrowsers = create<{ list: Browser[] }>(() => ({ list: [] }));

export async function loadBrowsers(): Promise<void> {
  if (!isTauri()) return;
  try {
    useBrowsers.setState({ list: await call(commands.webBrowsers()) });
  } catch (e) {
    console.warn("web browsers", e);
  }
}

export const browserIcon = (id: string) => (hasIcon(`browser-${id}`) ? `browser-${id}` : "web");

/** Paths shown with the built-in preview beside the editor. */
export const useWebPreview = create<Record<string, boolean>>(() => ({}));

export function togglePreview(path: string, on = !useWebPreview.getState()[path]) {
  useWebPreview.setState({ [path]: on });
}

/** The built-in server's URL for `path`. */
export function webUrl(path: string): Promise<string> {
  return call(commands.webUrl(path));
}

/** Saves all documents (the server reads the disk), then opens `path` in `browser` or the default browser. */
export async function openInBrowser(path: string, browser: string | null = null): Promise<void> {
  try {
    await executeAction("file.save");
    await call(commands.webOpen(await webUrl(path), browser));
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot open the browser",
      body: e instanceof Error ? e.message : String(e),
      key: "web-open",
    });
  }
}

/** Files a page can load besides markup: styles, scripts, data, images, fonts, media. */
const WEB_RESOURCE =
  /\.(css|m?js|cjs|jsx|tsx?|json|map|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|wasm|mp3|mp4|webm|ogg|wav)$/i;

/** A change to it can change what the built-in preview shows (it reloads for these only). */
export function isWebResource(path: string): boolean {
  return isHtmlPath(path) || WEB_RESOURCE.test(path);
}
