/**
 * JavaScript Debug: js-debug starts Chrome or Edge on a URL and debugs the page's scripts
 * in their sources (through source maps), like WebStorm's JavaScript Debug configuration.
 * Only Debug applies (`debugOnly`): the server behind the URL is another configuration's.
 */
import type { LaunchConfig, RunConfig } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import type { RunConfigTypeContribution } from "@/workbench/contributions";

export const JS_BROWSER = "js-browser";

type Params = Readonly<Record<string, string>>;

/** A URL the browser can open, with `http://` assumed for `localhost:5173`. */
export function browserUrl(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`;
  return /^(https?|file):\/\//i.test(url) && URL.canParse(url) ? url : null;
}

export const jsBrowserType: RunConfigTypeContribution = {
  id: JS_BROWSER,
  label: "JavaScript Debug",
  icon: "browser-chrome",
  description: "Open a page in Chrome or Edge and debug its JavaScript and TypeScript",
  defaults: { url: "http://localhost:5173", browser: "chrome" },
  debugOnly: true,
  debugAdapter: "js-debug",
  fields: [
    {
      key: "url",
      label: "URL",
      mono: true,
      required: true,
      validate: (v) => (browserUrl(v) ? null : "Enter an http, https or file URL"),
      hint: "Start the page's server first, e.g. the dev script of package.json",
    },
    {
      key: "browser",
      label: "Browser",
      control: "select",
      options: [
        { value: "chrome", label: "Chrome" },
        { value: "edge", label: "Edge" },
      ],
    },
    {
      key: "webRoot",
      label: "Web root",
      mono: true,
      placeholder: "Project root",
      hint: "Folder whose files the URL serves",
      browse: "directory",
    },
  ],
  commandLine: () => null,
};

export const isBrowserConfig = (c: Pick<RunConfig, "kind">) => c.kind === JS_BROWSER;

function isAbsolute(p: string) {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

function webRootOf(p: Params, root: string): string {
  const dir = p.webRoot?.trim().replace(/^\.\//, "");
  if (!dir || dir === ".") return root;
  return isAbsolute(dir) ? dir : `${root.replace(/[\\/]$/, "")}/${dir}`;
}

export type DebugBrowser = "chrome" | "edge";

/** The launch request that opens `url` in `browser` and debugs the page; `webRoot` holds the page's sources. */
export function browserLaunch(name: string, url: string, browser: DebugBrowser, webRoot: string): LaunchConfig {
  return {
    name,
    adapter: "js-debug",
    request: "launch",
    program: null,
    args: [],
    cwd: webRoot,
    env: {},
    extraJson: JSON.stringify({
      type: browser === "edge" ? "pwa-msedge" : "pwa-chrome",
      url,
      webRoot,
      skipFiles: workflowSettings().debugger.skipLibraryCode ? ["**/node_modules/**"] : [],
    }),
  };
}

/** The launch request of a JavaScript Debug configuration, or null without a usable URL. */
export function browserLaunchConfig(rc: RunConfig, root: string): LaunchConfig | null {
  const p = rc.params ?? {};
  const url = browserUrl(p.url);
  if (!url) return null;
  // The session belongs to the project (its browser profile is the project's), wherever the web root is.
  return { ...browserLaunch(rc.name, url, p.browser === "edge" ? "edge" : "chrome", webRootOf(p, root)), cwd: root };
}

/** The js-debug `type` of a launch request started under js-debug, or null. */
function jsDebugType(launch: LaunchConfig | null): unknown {
  if (launch?.adapter !== "js-debug" || launch.request !== "launch" || !launch.extraJson) return null;
  try {
    return (JSON.parse(launch.extraJson) as { type?: unknown }).type ?? null;
  } catch {
    return null;
  }
}

/** The browser `launch` opens under js-debug, or null. */
export function launchedBrowser(launch: LaunchConfig | null): DebugBrowser | null {
  const type = jsDebugType(launch);
  return type === "pwa-chrome" ? "chrome" : type === "pwa-msedge" ? "edge" : null;
}

/** Whether `launch` opens a browser under js-debug. */
export function isBrowserLaunch(launch: LaunchConfig | null): boolean {
  return launchedBrowser(launch) !== null;
}

/** The URL a browser launch opens. */
export function launchedUrl(launch: LaunchConfig): string | null {
  try {
    const url = (JSON.parse(launch.extraJson ?? "{}") as { url?: unknown }).url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}
