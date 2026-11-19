/**
 * Flutter DevTools as tool windows, one per Android Studio window: the same pages, with the same
 * parameters, of the project's DevTools server.
 */
import { create } from "zustand";
import { setContext } from "@/platform/context";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { lazyComponent } from "@/ui";
import { registerToolWindow } from "@/workbench/contributions";

export interface DevToolsWindow {
  id: string;
  title: string;
  icon: string;
  /** Path of the page; empty for DevTools' own navigation. */
  page: string;
  /** Screens left out of that navigation. */
  hide?: string;
  /** Which app the page connects to: one page per app, the latest app, or none. */
  app: "each" | "latest" | "none";
}

// In Android Studio's stripe order.
export const DEVTOOLS_WINDOWS: readonly DevToolsWindow[] = [
  {
    id: "flutter-deep-links",
    title: "Flutter Deep Links",
    icon: "toolwindow-flutter-deep-links",
    page: "deep-links",
    app: "none",
  },
  {
    id: "flutter-devtools",
    title: "Flutter DevTools",
    icon: "toolwindow-flutter-devtools",
    page: "",
    hide: "home,inspector,deep-links,extensions,debugger",
    app: "latest",
  },
  {
    id: "flutter-devtools-extensions",
    title: "Flutter DevTools Extensions",
    icon: "toolwindow-flutter-extensions",
    page: "",
    hide: "all-except-extensions",
    app: "latest",
  },
  {
    id: "flutter-inspector",
    title: "Flutter Inspector",
    icon: "toolwindow-flutter-inspector",
    page: "inspector",
    app: "each",
  },
];

export interface DevToolsLook {
  theme: "light" | "dark";
  /** Hex digits, without `#`. */
  background?: string;
}

/** The IDE's look, for a page about to load. Like Android Studio, a loaded page keeps its own. */
export function currentDevToolsLook(root = document.documentElement): DevToolsLook {
  const background = /^#([0-9a-f]{6})$/i.exec(getComputedStyle(root).getPropertyValue("--bg-editor").trim())?.[1];
  return { theme: root.dataset.theme === "light" ? "light" : "dark", ...(background ? { background } : {}) };
}

/** A DevTools page; with `embedded`, the form for a tool window. */
export function devToolsUrl(
  server: string,
  window: Pick<DevToolsWindow, "page" | "hide">,
  { uri, embedded }: { uri?: string; embedded?: DevToolsLook },
): string {
  const query = new URLSearchParams({ ide: "OpenIDEA" });
  if (embedded) {
    query.set("embedMode", window.hide ? "many" : "one");
    if (window.hide) query.set("hide", window.hide);
    query.set("theme", embedded.theme);
    if (embedded.background) query.set("backgroundColor", embedded.background);
  }
  if (uri) query.set("uri", uri);
  return `${server}/${window.page}?${query}`;
}

/** Bumped by Refresh, per window: the page loads again, on a server started anew if it is gone. */
export const useDevToolsRefresh = create<Record<string, number>>(() => ({}));

export function refreshDevTools(id: string) {
  useDevToolsRefresh.setState((s) => ({ [id]: (s[id] ?? 0) + 1 }));
}

const view = (name: "FlutterDevToolsView" | "FlutterDevToolsTabs" | "FlutterDevToolsRefresh") =>
  lazyComponent(() => import("../ui/FlutterDevTools").then((m) => m[name]));

/** A Flutter project's `pubspec.yaml`, by the rule the run and debug backends use. */
export const isFlutterPubspec = (text: string) => text.includes("sdk: flutter");

/** Keeps the tool windows registered while the project's root `pubspec.yaml` depends on Flutter. */
export function registerDevToolsWindows(): () => void {
  let dispose: (() => void)[] | null = null;
  const sync = (flutter: boolean) => {
    setContext("flutterDevTools", flutter);
    if (!flutter) {
      dispose?.forEach((d) => d());
      dispose = null;
      return;
    }
    dispose ??= DEVTOOLS_WINDOWS.map((w, i) =>
      registerToolWindow({
        id: w.id,
        title: w.title,
        icon: w.icon,
        anchor: "right",
        order: 40 + i,
        component: view("FlutterDevToolsView"),
        headerActions: view("FlutterDevToolsRefresh"),
        ...(w.app === "each" ? { headerContent: view("FlutterDevToolsTabs") } : {}),
      }),
    );
  };
  let pubspec: string | null = null;
  let check = 0;
  const load = () => {
    const root = useProject.getState().project?.root;
    const seq = ++check;
    pubspec = root ? `${root}/pubspec.yaml` : null;
    if (!pubspec) return sync(false);
    call(commands.fsReadText(pubspec)).then(
      (text) => seq === check && sync(isFlutterPubspec(text)),
      () => seq === check && sync(false),
    );
  };
  load();
  const offProject = useProject.subscribe((s, prev) => {
    if (s.project?.root !== prev.project?.root) load();
  });
  const offFs = onIdeEvent("fsChanged", (e) => {
    if (pubspec && [...e.created, ...e.modified, ...e.removed].includes(pubspec)) load();
  });
  return () => {
    offProject();
    offFs();
    check++;
    sync(false);
  };
}
