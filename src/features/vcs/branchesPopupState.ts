/** Where the Git Branches popup is open from, shared by the branch widgets and the popups they anchor. */
import { create } from "zustand";

/** `from`: the widget the popup opened from (the status bar's or, by default, the toolbar's). */
export const useBranchesPopup = create<{ open: boolean; from?: BranchWidgetPlace }>(() => ({ open: false }));
/** Opens it from the toolbar widget (or whichever widget is shown): VCS › Branches… and its shortcut. */
export const showBranchesPopup = () => useBranchesPopup.setState({ open: true, from: undefined });

export type BranchWidgetPlace = "toolbar" | "status";

/** The status bar's Git Branch widget (IDEA's status bar widget of the same name), off by default. */
export const STATUS_BRANCH_WIDGET = { id: "vcs.statusBranch", title: "Git Branch", defaultVisible: false } as const;

/** The branch widget a popup anchors to: the one it opened from, else whichever is shown. */
export function branchWidgetAnchor(from: BranchWidgetPlace | undefined): Element | null {
  return (
    document.querySelector(`[data-branches-widget="${from ?? "toolbar"}"]`) ??
    document.querySelector("[data-branches-widget]")
  );
}
