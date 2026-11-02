/**
 * Content tabs of the Pull Requests tool window (IntelliJ's `ReviewToolwindowTabsManager`):
 * the list tab (not closable), one `#N` tab per opened pull request and the "New Pull
 * Request" tab, each opened at most once. Also the list's selection, which actions such as
 * Checkout Pull Request… use.
 */
import { create } from "zustand";
import { setContext } from "@/platform/context";

export type GhTab = { kind: "pr"; number: number } | { kind: "create" };
export type GhTabId = "list" | `pr:${number}` | "create";

interface TabsState {
  tabs: GhTab[];
  active: GhTabId;
  /** The pull request selected in the list. */
  listSelection: number | null;
}

export const useGhTabs = create<TabsState>(() => ({ tabs: [], active: "list", listSelection: null }));

export const tabId = (t: GhTab): GhTabId => (t.kind === "pr" ? `pr:${t.number}` : "create");

/** Opens (or selects) the `#N` tab. */
export function openPullRequestTab(number: number) {
  useGhTabs.setState((s) => ({
    tabs: s.tabs.some((t) => t.kind === "pr" && t.number === number) ? s.tabs : [...s.tabs, { kind: "pr", number }],
    active: `pr:${number}`,
  }));
}

/** Opens (or selects) the "New Pull Request at {repo}" tab. */
export function openCreateTab() {
  useGhTabs.setState((s) => ({
    tabs: s.tabs.some((t) => t.kind === "create") ? s.tabs : [...s.tabs, { kind: "create" }],
    active: "create",
  }));
}

export function selectTab(id: GhTabId) {
  useGhTabs.setState({ active: id });
}

/** Closes a `#N` or the New Pull Request tab; the tab before it becomes active. */
export function closeTab(id: GhTabId) {
  if (id === "list") return;
  useGhTabs.setState((s) => {
    const i = s.tabs.findIndex((t) => tabId(t) === id);
    if (i < 0) return s;
    const tabs = s.tabs.filter((_, j) => j !== i);
    const before = tabs[i - 1];
    const active = s.active === id ? (before ? tabId(before) : "list") : s.active;
    return { tabs, active };
  });
}

export function setListSelection(number: number | null) {
  useGhTabs.setState({ listSelection: number });
}

/** The pull request of the active `#N` tab, else the list's selection. */
export function contextPullRequest(): number | null {
  const s = useGhTabs.getState();
  const m = /^pr:(\d+)$/.exec(s.active);
  return m ? Number(m[1]) : s.listSelection;
}

/** Another repository or project: only the list tab stays. */
export function resetTabs() {
  useGhTabs.setState({ tabs: [], active: "list", listSelection: null });
}

/** `githubPrTab`: `list`, `pr` or `create`, for the tab-specific shortcuts (Refresh). */
useGhTabs.subscribe((s) => setContext("githubPrTab", s.active.startsWith("pr:") ? "pr" : s.active));
