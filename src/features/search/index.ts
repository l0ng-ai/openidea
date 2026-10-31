/**
 * Search & navigation: Search Everywhere (⇧⇧ and the Go to … choosers),
 * Recent Files / Recent Locations, Find / Replace in Files + the Find tool
 * window, the Structure tool window + File Structure popup, and bookmarks.
 */
import { lazyComponent } from "@/ui";
import { activeEditor, registerEditorContribution } from "@/editor/api";
import { executeAction, registerActions } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { EDIT_SCOPES_ACTION } from "@/platform/search";
import { isVirtualUri } from "@/platform/virtualDocs";
import { provideFindResults, registerMenuGroup, registerOverlay, registerToolWindow } from "@/workbench/contributions";
import { BookmarkPopupsOverlay } from "./bookmarks/BookmarkPopups";
import { bookmarkGutter } from "./bookmarks/gutter";
import {
  bookmarkByMnemonic,
  hasBookmark,
  loadBookmarks,
  pathBookmarkAt,
  renameBookmarks,
  renamePathBookmarks,
  toggleBookmark,
  togglePathBookmarks,
  toggleMnemonic,
  updateBookmarkData,
  updateBookmarks,
  useBookmarkPopups,
  useBookmarks,
  type Bookmark,
} from "./bookmarks/store";
import { openLocation } from "./common/open";
import { maybeToolWindowService } from "./common/services";
import { installTracking, resetTracking } from "./common/tracking";
import { SearchEverywhereOverlay } from "./everywhere/SearchEverywhere";
import { hideSearchEverywhere, showSearchEverywhere } from "./everywhere/store";
import { FindInFilesOverlay } from "./find/FindInFiles";
import { ScopesDialogOverlay, showScopesDialog } from "./find/ScopesDialog";
import { hideFindPopup, parseFindArg, runFindPopupCommand, showFindPopup, useFindPopup } from "./find/store";
import { disposeFindWindow, openEditorResults, rerunActiveFindTab, useFindHeaderMenu } from "./find/windowStore";
import { RecentPopupsOverlay } from "./recent/RecentPopups";
import { cycleSwitcher, hideRecentPopup, showRecentPopup } from "./recent/store";
import { FileStructureOverlay, useFileStructurePopup } from "./structure/StructureView";
import { useOutline, useStructureOptions } from "./structure/store";
import { tx } from "@/platform/i18n";

/** Single-line editor selection, used to prefill search fields. */
function editorSelectionText(): string | null {
  const view = activeEditor()?.view;
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  if (from === to || to - from > 200) return null;
  const text = view.state.sliceDoc(from, to);
  return text.includes("\n") ? null : text;
}

/** The active editor's caret line (and where to show a popup for it). */
function caretLine(): { path: string; line: number; text: string; at?: { x: number; y: number } } | null {
  const handle = activeEditor();
  if (!handle) return null;
  const head = handle.view.state.selection.main.head;
  const line = handle.view.state.doc.lineAt(head);
  const coords = handle.view.coordsAtPos(head);
  return {
    path: handle.ctx.path,
    line: line.number - 1,
    text: line.text,
    at: coords ? { x: coords.left, y: coords.bottom + 2 } : undefined,
  };
}

/** Bookmark description from the editor selection (F3 on a selection, as in IDEA). */
function selectionDescription(): string | null {
  const view = activeEditor()?.view;
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  const text = view.state
    .sliceDoc(from, Math.min(to, from + 1000))
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

type PopupKind = "everywhere" | "recent" | "find" | "fileStructure" | "bookmarks";

function closeAllPopups(except?: PopupKind) {
  if (except !== "bookmarks") useBookmarkPopups.setState({ chooser: null, list: false });
  if (except !== "everywhere") hideSearchEverywhere();
  if (except !== "recent") hideRecentPopup();
  if (except !== "find") hideFindPopup();
  if (except !== "fileStructure" && useFileStructurePopup.getState().open)
    useFileStructurePopup.setState({ open: false });
}

function lineText(path: string, line: number): string {
  const handle = activeEditor();
  const doc = handle?.ctx.path === path ? handle.view.state.doc : null;
  return doc && line < doc.lines ? doc.line(line + 1).text : "";
}

function jumpBookmark(dir: 1 | -1) {
  const handle = activeEditor();
  const items = useBookmarks.getState().items;
  if (!items.length) return;
  const path = handle?.ctx.path;
  const line = handle ? handle.view.state.doc.lineAt(handle.view.state.selection.main.head).number - 1 : -1;
  const order = items.map((b) => ({ b, k: `${b.path}\u0000${String(b.line).padStart(9, "0")}` }));
  const cur = `${path ?? ""}\u0000${String(line).padStart(9, "0")}`;
  const sorted = order.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const next =
    dir === 1
      ? (sorted.find((x) => x.k > cur) ?? sorted[0])
      : ([...sorted].reverse().find((x) => x.k < cur) ?? sorted[sorted.length - 1]);
  if (next) void openLocation(next.b.path, { line: next.b.line, col: 0 });
}

export function activate(): void | (() => void) {
  const se = (tab: Parameters<typeof showSearchEverywhere>[0]) => () => {
    closeAllPopups("everywhere");
    showSearchEverywhere(tab, { query: editorSelectionText() ?? undefined });
  };

  const disposers: Array<() => void> = [
    installTracking(),
    provideFindResults(openEditorResults),

    registerOverlay({ id: "search.everywhere", component: SearchEverywhereOverlay }),
    registerOverlay({ id: "search.recent", component: RecentPopupsOverlay }),
    registerOverlay({ id: "search.findInFiles", component: FindInFilesOverlay }),
    registerOverlay({ id: "search.scopes", component: ScopesDialogOverlay }),
    registerOverlay({ id: "search.fileStructure", component: FileStructureOverlay }),
    registerOverlay({ id: "search.bookmarks", component: BookmarkPopupsOverlay }),

    registerToolWindow({
      id: "structure",
      title: "Structure",
      icon: "toolwindow-structure",
      anchor: "left",
      // Left Bottom (split), as in IDEA: shows below Project.
      secondary: true,
      order: 20,
      component: lazyComponent(() => import("./structure/StructureView").then((m) => m.StructureView)),
    }),
    registerToolWindow({
      id: "bookmarks",
      title: "Bookmarks",
      icon: "toolwindow-bookmarks",
      // Left Bottom (split) with Structure, as in IDEA.
      anchor: "left",
      secondary: true,
      order: 30,
      component: lazyComponent(() => import("./bookmarks/BookmarksView").then((m) => m.BookmarksView)),
      headerActions: lazyComponent(() => import("./bookmarks/BookmarksView").then((m) => m.BookmarksActions)),
      useBadge: () => null,
    }),
    registerToolWindow({
      id: "find",
      title: "Find",
      icon: "toolwindow-find",
      anchor: "bottom",
      stripe: "onUse",
      order: 5,
      component: lazyComponent(() => import("./find/FindToolWindow").then((m) => m.FindToolWindow)),
      headerContent: lazyComponent(() => import("./find/FindToolWindow").then((m) => m.FindTabs)),
      headerActions: lazyComponent(() => import("./find/FindToolWindow").then((m) => m.FindToolWindowActions)),
      headerMenu: useFindHeaderMenu,
    }),

    registerEditorContribution({
      id: "search.bookmarks",
      order: 50,
      extensions: (ctx) =>
        bookmarkGutter(ctx.path, (line) => void executeAction("navigate.toggleBookmark", { path: ctx.path, line })),
    }),
    registerMenuGroup({
      // Select In › Structure: the Structure tool window follows the active editor.
      id: "search.structure.selectIn",
      menus: ["selectIn"],
      items: (_menu, { paths: [path] }) =>
        path && activeEditor()?.ctx.path === path
          ? [
              {
                label: "Structure",
                icon: "toolwindow-structure",
                run: () => maybeToolWindowService()?.show("structure", true),
              },
            ]
          : [],
    }),
    registerMenuGroup({
      id: "search.bookmarks",
      menus: ["editorGutter"],
      order: 20,
      items: (_menu, { paths: [path], line }) => {
        if (!path || line == null) return [];
        const on = hasBookmark(useBookmarks.getState().items, path, line);
        return [
          {
            label: on ? "Remove Bookmark" : "Add Bookmark",
            shortcut: shortcutLabel("navigate.toggleBookmark"),
            run: () => void executeAction("navigate.toggleBookmark", { path, line }),
          },
        ];
      },
    }),

    registerMenuGroup({
      // File / folder bookmarks (IDEA's Bookmarks › Toggle Bookmark on the project view and editor tabs).
      id: "search.bookmarks.files",
      menus: ["projectView", "editorTab"],
      order: 60,
      items: (_menu, { paths, dirs }) => {
        const targets = paths
          .map((path, i) => ({ path, dir: dirs?.[i] ?? false }))
          .filter((t) => !isVirtualUri(t.path));
        if (!targets.length) return [];
        const on = targets.every((t) => pathBookmarkAt(useBookmarks.getState().paths, t.path));
        return [
          {
            label: on ? "Remove Bookmark" : "Add Bookmark",
            icon: "bookmark",
            run: () => void executeAction("bookmarks.toggleFileBookmark", { targets }),
          },
        ];
      },
    }),

    registerActions([
      {
        id: "navigate.searchEverywhere",
        title: "Search Everywhere",
        category: "Navigate",
        icon: "search",
        keywords: ["find", "goto", "everything"],
        run: se("all"),
      },
      {
        id: "navigate.gotoClass",
        title: "Go to Class…",
        category: "Navigate",
        keywords: ["type", "interface", "struct"],
        when: "projectOpen",
        run: se("classes"),
      },
      {
        id: "navigate.gotoFile",
        title: "Go to File…",
        category: "Navigate",
        icon: "file",
        keywords: ["open file"],
        when: "projectOpen",
        run: se("files"),
      },
      {
        id: "navigate.gotoSymbol",
        title: "Go to Symbol…",
        category: "Navigate",
        keywords: ["function", "method", "field"],
        when: "projectOpen",
        run: se("symbols"),
      },
      {
        id: "navigate.findAction",
        title: "Find Action…",
        category: "Help",
        keywords: ["command", "palette"],
        run: se("actions"),
      },
      {
        id: "navigate.searchText",
        title: "Search Text Everywhere",
        category: "Navigate",
        keywords: ["grep", "find text"],
        when: "projectOpen",
        run: se("text"),
      },
      {
        id: "navigate.recentFiles",
        title: "Recent Files",
        category: "Navigate",
        icon: "history",
        keywords: ["switcher"],
        when: "projectOpen",
        run: () => {
          closeAllPopups("recent");
          showRecentPopup("files");
        },
      },
      {
        id: "navigate.switcher",
        title: "Switcher",
        category: "Navigate",
        keywords: ["recent files", "tabs"],
        when: "projectOpen",
        run: () => {
          closeAllPopups("recent");
          cycleSwitcher(1);
        },
      },
      {
        id: "navigate.switcherBack",
        title: "Switcher (Backward)",
        category: "Navigate",
        hidden: true,
        when: "projectOpen",
        run: () => {
          closeAllPopups("recent");
          cycleSwitcher(-1);
        },
      },
      {
        id: "navigate.recentLocations",
        title: "Recent Locations",
        category: "Navigate",
        icon: "clock",
        when: "projectOpen",
        run: () => {
          closeAllPopups("recent");
          showRecentPopup("locations");
        },
      },
      {
        id: "find.inPath",
        title: "Find in Files…",
        category: "Find",
        icon: "search",
        keywords: ["grep", "search in path"],
        when: "projectOpen",
        run: ({ arg }) => {
          closeAllPopups("find");
          showFindPopup(false, { ...parseFindArg(arg), selection: editorSelectionText() });
        },
      },
      {
        // Rerun the selected search; ⌘R in the Find tool window, as in IDEA.
        id: "find.rerun",
        title: "Rerun Search",
        category: "Find",
        icon: "refresh",
        when: "projectOpen && activeToolWindow == 'find'",
        run: rerunActiveFindTab,
      },
      {
        id: EDIT_SCOPES_ACTION,
        title: "Edit Scopes…",
        category: "Find",
        keywords: ["custom scope", "file pattern"],
        when: "projectOpen",
        run: ({ arg }) => showScopesDialog(arg),
      },
      {
        id: "find.replaceInPath",
        title: "Replace in Files…",
        category: "Find",
        icon: "replace",
        when: "projectOpen",
        run: ({ arg }) => {
          closeAllPopups("find");
          showFindPopup(true, { ...parseFindArg(arg), selection: editorSelectionText() });
        },
      },
      // Keys of the Find in Files popup that are global shortcuts elsewhere (bound after them).
      ...(
        [
          ["find.popup.nextResult", "Next Result", "nextResult"],
          ["find.popup.previousResult", "Previous Result", "previousResult"],
          ["find.popup.openResult", "Open Result", "openResult"],
          ["find.popup.recentSearches", "Recent Searches", "recentSearches"],
        ] as const
      ).map(([id, title, command]) => ({
        id,
        title,
        category: "Find",
        hidden: true,
        when: "findPopupOpen",
        run: () => void runFindPopupCommand(command),
      })),
      {
        id: "navigate.fileStructure",
        title: "File Structure",
        category: "Navigate",
        icon: "structure",
        keywords: ["outline", "members"],
        run: () => {
          // Pressed again, IDEA toggles "Show inherited members" (when the server knows supertypes).
          if (useFileStructurePopup.getState().open) {
            if (useOutline.getState().inheritedSupported)
              useStructureOptions.setState((s) => ({ showInherited: !s.showInherited }));
            return;
          }
          closeAllPopups("fileStructure");
          useFileStructurePopup.setState({ open: true });
        },
      },
      {
        id: "navigate.toggleBookmark",
        title: "Toggle Bookmark",
        category: "Bookmarks",
        icon: "bookmark",
        when: "projectOpen",
        run: ({ arg }) => {
          const a = (arg ?? {}) as { path?: unknown; line?: unknown };
          if (typeof a.path === "string" && typeof a.line === "number") {
            const { path, line } = a as { path: string; line: number };
            updateBookmarks((list) => toggleBookmark(list, path, line, lineText(path, line)));
            return;
          }
          const at = caretLine();
          if (!at) return;
          const description = selectionDescription();
          updateBookmarks((list) => toggleBookmark(list, at.path, at.line, at.text, Date.now(), description));
        },
      },
      {
        id: "bookmarks.toggleFileBookmark",
        title: "Toggle File Bookmark",
        category: "Bookmarks",
        icon: "bookmark",
        when: "projectOpen",
        run: ({ arg }) => {
          const given = (arg as { targets?: unknown } | undefined)?.targets;
          const targets = Array.isArray(given)
            ? given.filter((t): t is { path: string; dir: boolean } => typeof t?.path === "string")
            : activeEditor()
              ? [{ path: activeEditor()!.ctx.path, dir: false }]
              : [];
          updateBookmarkData((d) =>
            togglePathBookmarks(
              d,
              targets.map((t) => ({ path: t.path, dir: !!t.dir })),
            ),
          );
        },
      },
      {
        id: "bookmarks.newList",
        title: "New Bookmark List…",
        category: "Bookmarks",
        when: "projectOpen",
        run: () => {
          useBookmarkPopups.setState({ naming: {} });
        },
      },
      {
        id: "navigate.toggleBookmarkWithMnemonic",
        title: "Toggle Bookmark with Mnemonic",
        category: "Bookmarks",
        when: "projectOpen && textEditorActive",
        run: () => {
          const at = caretLine();
          if (!at) return;
          closeAllPopups("bookmarks");
          useBookmarkPopups.setState({ chooser: at });
        },
      },
      ...[..."0123456789"].flatMap((d) => [
        {
          id: `navigate.toggleBookmark${d}`,
          title: tx`Toggle Bookmark ${d}`,
          category: "Bookmarks",
          when: "projectOpen && textEditorActive",
          run: () => {
            const at = caretLine();
            if (at) updateBookmarks((list) => toggleMnemonic(list, at.path, at.line, at.text, d));
          },
        },
        {
          id: `navigate.gotoBookmark${d}`,
          title: tx`Go to Bookmark ${d}`,
          category: "Bookmarks",
          when: "projectOpen",
          run: () => {
            const b = bookmarkByMnemonic(useBookmarks.getState().items, d);
            if (b) void openLocation(b.path, { line: b.line, col: 0 });
          },
        },
      ]),
      {
        // ⌘F3 opens the Bookmarks popup, as IDEA; the tool window stays on its own shortcut.
        id: "navigate.showBookmarks",
        title: "Show Bookmarks",
        category: "Bookmarks",
        icon: "bookmark",
        when: "projectOpen",
        run: () => {
          closeAllPopups("bookmarks");
          useBookmarkPopups.setState({ list: true });
        },
      },
      {
        id: "navigate.nextBookmark",
        title: "Next Bookmark",
        category: "Bookmarks",
        when: "projectOpen",
        run: () => jumpBookmark(1),
      },
      {
        id: "navigate.prevBookmark",
        title: "Previous Bookmark",
        category: "Bookmarks",
        when: "projectOpen",
        run: () => jumpBookmark(-1),
      },
    ]),
  ];

  const onProject = (root: string | null) => {
    closeAllPopups();
    disposeFindWindow();
    loadBookmarks(root);
  };
  onProject(useProject.getState().project?.root ?? null);
  disposers.push(
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      onProject(s.project?.root ?? null);
      resetTracking();
      // A directory scope pointed into the previous project.
      if (useFindPopup.getState().scopeTab === "directory")
        useFindPopup.setState({ scopeTab: "project", directory: "" });
    }),
    onIdeEvent("fsChanged", (e) => {
      if (!e.removed.length) return;
      updateBookmarks((list) => e.removed.reduce<Bookmark[]>((acc, p) => renameBookmarks(acc, p, null), [...list]));
      updateBookmarkData((d) => {
        const paths = e.removed.reduce((acc, p) => renamePathBookmarks(acc, p, null), d.paths);
        return paths.length === d.paths.length ? d : { ...d, paths };
      });
    }),
  );

  return () => {
    closeAllPopups();
    disposeFindWindow();
    disposers.reverse().forEach((d) => d());
  };
}
