/**
 * Which page the phone shell shows. The bottom bar has fixed pages (Agents,
 * Editor, Git, Database) and More, which lists every other tool window; one of
 * those opens as a page of its own (`tool:<id>`).
 *
 * The shell follows the tool window layout: whatever shows a tool window (an
 * action, a link in another view) turns to its page, and opening a file turns to
 * the editor, shown over the page it was opened from. So features keep calling
 * `toolWindowService().show(id)` and the editor service as on the desktop.
 */
import { create } from "zustand";
import { useToolWindowLayout } from "../toolwindows/store";
import { maybeEditorService } from "../contributions";
import { recordPageUse } from "./tabs";

export type MobilePage = "agents" | "editor" | "git" | "database" | "more" | `tool:${string}`;

/** Tool windows with a page of their own in the bottom bar. Git shows Commit and the log. */
export const PAGE_OF_TOOL_WINDOW: Readonly<Record<string, MobilePage>> = {
  agents: "agents",
  commit: "git",
  git: "git",
  database: "database",
};

export const GIT_VIEWS = ["commit", "git"] as const;
export type GitView = (typeof GIT_VIEWS)[number];

export function pageOfToolWindow(id: string): MobilePage {
  return PAGE_OF_TOOL_WINDOW[id] ?? `tool:${id}`;
}

/** The tool window a page shows, if any; Git's depends on the view chosen there. */
export function toolWindowOfPage(
  page: MobilePage,
  gitView: GitView,
  registered: (id: string) => boolean,
): string | null {
  if (page.startsWith("tool:")) return page.slice("tool:".length);
  if (page === "agents" || page === "database") return page;
  if (page === "git") return registered(gitView) ? gitView : (GIT_VIEWS.find(registered) ?? null);
  return null;
}

interface MobileShellState {
  page: MobilePage;
  gitView: GitView;
  /**
   * The page an editor was opened from (a diff from Git, a file from an agent's reply): the
   * editor shows over it and Back returns there, instead of the user landing in the Editor tab.
   */
  returnTo: MobilePage | null;
  /** The tab opened for that, which Back closes again; `null` when it was open already. */
  pushed: string | null;
}

export const useMobileShell = create<MobileShellState>(() => ({
  page: "editor",
  gitView: "commit",
  returnTo: null,
  pushed: null,
}));

export function setMobilePage(page: MobilePage) {
  const s = useMobileShell.getState();
  if (s.page !== page || s.returnTo) useMobileShell.setState({ page, returnTo: null, pushed: null });
  if (s.page !== page) recordPageUse(page);
}

/** Shows the editor over the current page for tab `key` (`opened`: a tab that was not open before). */
export function pushEditor(key: string, opened: boolean) {
  const { page, returnTo } = useMobileShell.getState();
  if (page === "editor") return;
  useMobileShell.setState({ page: "editor", returnTo: returnTo ?? page, pushed: opened ? key : null });
}

/** Back from an editor shown over a page: to that page, closing the tab opened for it. */
export function popEditor() {
  const { returnTo, pushed } = useMobileShell.getState();
  useMobileShell.setState({ page: returnTo ?? "editor", returnTo: null, pushed: null });
  const editor = maybeEditorService();
  if (!pushed || !editor?.closeInput) return;
  // The tab that becomes active in its place was not opened from the page.
  closing++;
  void Promise.resolve(editor.closeInput(pushed)).finally(() => closing--);
}

/** Tabs being closed by Back: the editor's active tab changes without the user opening one. */
let closing = 0;

function followToolWindow(id: string) {
  const page = pageOfToolWindow(id);
  if (page === "git") {
    if (useMobileShell.getState().page !== "git") recordPageUse(page);
    useMobileShell.setState({ page, gitView: id as GitView });
  } else setMobilePage(page);
}

/** Turns to the page of a tool window when something shows it, and to the editor when a file opens. */
export function installMobileShellFollow(): () => void {
  const offLayout = useToolWindowLayout.subscribe((s, prev) => {
    if (s.lastActive && s.lastActive !== prev.lastActive) followToolWindow(s.lastActive);
    else if (s.focusRequest && s.focusRequest !== prev.focusRequest) followToolWindow(s.focusRequest.id);
  });
  // The editor area provides its service once it mounts, which may be after the shell.
  let offEditor = () => {};
  let wait = 0;
  const follow = () => {
    const editor = maybeEditorService();
    if (!editor?.onActiveInputChange) {
      wait = window.setTimeout(follow, 100);
      return;
    }
    let open = new Set((editor.openTabs?.() ?? []).map((t) => t.input.key));
    offEditor = editor.onActiveInputChange((input) => {
      if (input && !closing) pushEditor(input.key, !open.has(input.key));
      open = new Set((editor.openTabs?.() ?? []).map((t) => t.input.key));
    });
  };
  follow();
  return () => {
    window.clearTimeout(wait);
    offLayout();
    offEditor();
  };
}
