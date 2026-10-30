/**
 * Extensions of the branch widget and its Branches popup contributed by other features
 * (IDEA's `GitCurrentBranchPresenter` and the `Git.Experimental.Branch.Popup.Actions` group):
 *
 * - a presentation of the current branch (icon, text, tooltip) replacing the widget's own,
 *   as the GitHub plugin shows "#12 on feature" for a pull request's branch;
 * - actions added to the popup's top, after its own (a separator before each extension's).
 *
 * An extension is provided under an id and replaced by providing it again (it follows its
 * owner's state); the disposer removes it.
 *
 *   const dispose = provideBranchWidgetExtension({ id: "github", presentation: { text: "#12 on feature" } });
 */
import { create } from "zustand";
import type { PopupAction } from "./branches";

export interface BranchPresentation {
  /** Replaces the branch icon. */
  icon?: string;
  text: string;
  /** Shown above the widget's own tooltip lines. */
  tooltip?: string;
}

export interface BranchWidgetExtension {
  id: string;
  /** Lower first (presentation: the first one wins). Default 100. */
  order?: number;
  presentation?: BranchPresentation | null;
  actions?: readonly PopupAction[];
}

export const useBranchWidgetExtensions = create<{ extensions: ReadonlyMap<string, BranchWidgetExtension> }>(() => ({
  extensions: new Map(),
}));

/** Provides (or replaces) extension `ext.id`; returns its disposer. */
export function provideBranchWidgetExtension(ext: BranchWidgetExtension): () => void {
  useBranchWidgetExtensions.setState((s) => ({ extensions: new Map(s.extensions).set(ext.id, ext) }));
  return () =>
    useBranchWidgetExtensions.setState((s) => {
      if (s.extensions.get(ext.id) !== ext) return s;
      const extensions = new Map(s.extensions);
      extensions.delete(ext.id);
      return { extensions };
    });
}

const ordered = (m: ReadonlyMap<string, BranchWidgetExtension>) =>
  [...m.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

/** The presentation replacing the widget's, if any. */
export function branchPresentation(m: ReadonlyMap<string, BranchWidgetExtension>): BranchPresentation | null {
  return ordered(m).find((e) => e.presentation)?.presentation ?? null;
}

/** The extensions' popup actions, each extension in a group of its own. */
export function extensionPopupActions(m: ReadonlyMap<string, BranchWidgetExtension>): PopupAction[] {
  return ordered(m).flatMap((e) => (e.actions ?? []).map((a) => ({ ...a, group: `ext:${e.id}` })));
}
