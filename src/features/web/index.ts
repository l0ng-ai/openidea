/**
 * Web browsers (IDEA's Open In › Browser and the editor's browser bar): HTML
 * and SVG files open in an installed browser through the built-in server, and
 * HTML files get a built-in preview beside the editor. ⌃⇧R in an HTML editor
 * opens the default browser, like IDEA's Run for HTML files. HTML files with
 * Django template tags offer the Django Template language.
 */
import { registerActions } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { onFileTypesChange } from "@/platform/fileTypes";
import { basename } from "@/platform/project";
import { lazyComponent, type MenuItem } from "@/ui";
import {
  maybeEditorService,
  registerEditorBanner,
  registerMenuGroup,
  registerTextEditorWrapper,
  useTextEditorWrappers,
} from "@/workbench/contributions";
import { activeEditor, registerEditorContribution } from "@/editor/api";
import { djangoContentWatcher, djangoTemplateBanner } from "./djangoTemplates";
import {
  browserIcon,
  isHtmlPath,
  isWebPagePath,
  isWebPath,
  loadBrowsers,
  openInBrowser,
  togglePreview,
  useBrowsers,
  useWebPreview,
} from "./browsers";
import { tx } from "@/platform/i18n";

interface OpenArg {
  path?: string;
  browser?: string;
}

function targetPath(arg: unknown): string | null {
  if (typeof arg === "string") return arg;
  const path = (arg as OpenArg | undefined)?.path ?? getContext().editorPath;
  return typeof path === "string" ? path : null;
}

async function showPreview(path: string) {
  await maybeEditorService()?.openFile(path, { focus: true });
  const editor = activeEditor();
  if (editor?.tabId && editor.ctx.path === path) togglePreview(editor.tabId, true);
}

/** The tab a preview button passes, or the focused HTML editor's. */
function previewTab(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  const editor = activeEditor();
  return editor && isHtmlPath(editor.ctx.path) ? editor.tabId : undefined;
}

function browserMenu(path: string): MenuItem {
  const html = isHtmlPath(path);
  return {
    label: "Browser",
    icon: "web",
    submenu: [
      { kind: "action", action: "web.openInBrowser", arg: { path }, label: "Default Browser" },
      { kind: "separator" },
      ...(html ? [{ label: "Built-in Preview", icon: "eye", run: () => void showPreview(path) }] : []),
      ...useBrowsers.getState().list.map((b): MenuItem => ({
        label: b.name,
        verbatim: true,
        icon: browserIcon(b.id),
        run: () => void openInBrowser(path, b.id),
      })),
    ],
  };
}

export function activate(): () => void {
  void loadBrowsers();
  const disposers = [
    // Open tabs gain or lose the browser bar and preview when File Types change.
    onFileTypesChange(() => useTextEditorWrappers.setState((w) => ({ wrappers: new Map(w.wrappers) }))),
    registerEditorBanner(djangoTemplateBanner),
    registerEditorContribution({ id: "web.djangoContent", order: 57, extensions: djangoContentWatcher }),
    registerTextEditorWrapper({
      id: "web.html",
      matches: isHtmlPath,
      component: lazyComponent(() => import("./WebEditor").then((m) => m.WebEditor)),
    }),
    registerActions([
      {
        id: "web.openInBrowser",
        title: "Open in Browser",
        description: "Open the HTML or SVG file in the default browser through the built-in server",
        category: "View",
        icon: "web",
        when: "projectOpen",
        keyWhen: "textEditorActive && editorLangId == html",
        keywords: ["browser", "html", "preview", "chrome", "firefox", "safari", "run"],
        run: ({ arg }) => {
          const path = targetPath(arg);
          if (path && isWebPath(path)) return openInBrowser(path, (arg as OpenArg | undefined)?.browser ?? null);
        },
      },
      {
        id: "web.togglePreview",
        title: "Built-in Preview",
        description: "Show the HTML file rendered beside the editor",
        category: "View",
        icon: "eye",
        when: "textEditorActive && editorLangId == html",
        keywords: ["browser", "html", "preview", "live"],
        toggled: () => {
          const tabId = previewTab(undefined);
          return !!tabId && !!useWebPreview.getState()[tabId];
        },
        run: ({ arg }) => {
          const tabId = previewTab(arg);
          if (tabId) togglePreview(tabId);
        },
      },
    ]),
    registerMenuGroup({
      id: "web.open",
      menus: ["editor", "editorTab", "projectView"],
      order: 5,
      items: (_menu, { paths, dirs }) => {
        const path = paths.length === 1 && !dirs?.[0] ? paths[0]! : null;
        if (!path || !isWebPagePath(path)) return [];
        return [
          {
            kind: "action",
            action: "web.openInBrowser",
            arg: { path },
            label: tx`Open '${basename(path)}' in Browser`,
            icon: "web",
          },
        ];
      },
    }),
    registerMenuGroup({
      id: "web.openIn",
      menus: ["openIn"],
      items: (_menu, { paths, dirs }) =>
        paths.length === 1 && !dirs?.[0] && isWebPath(paths[0]!) ? [browserMenu(paths[0]!)] : [],
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
