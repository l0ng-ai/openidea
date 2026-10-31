/**
 * Diff viewer extension point (IDEA's `DiffExtension.onViewerCreated`): a provider looks at
 * the diff being shown (`DiffData`, usually its `context`) and may contribute CodeMirror
 * extensions to each pane (gutters, inlays), toolbar items, viewer settings and editor
 * context menu items. Features use it for code review (pull request threads in the diff).
 *
 *   registerDiffViewerProvider({
 *     id: "github.review",
 *     create: (data) => (data.context?.kind === "github.pullRequest" ? new ReviewDiff(data) : null),
 *   });
 *
 * A contribution lives as long as the diff tab shows that diff (`context`, path and sides);
 * `attach` runs each time the viewer (re)builds its panes (mode / option changes).
 */
import type { ComponentType } from "react";
import type { Extension, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MenuItem } from "@/ui";
import type { DiffData } from "./diffInput";
import type { DiffMode } from "./diffOptions";

export type DiffPaneSide = "left" | "right";

export interface DiffViewerPane {
  side: DiffPaneSide;
  view: EditorView;
}

/** Where a pane's extensions go: its side and whether it is the unified viewer's only pane. */
export interface DiffPaneInfo {
  side: DiffPaneSide;
  /** The unified viewer: the right side's document with the left side's deleted lines inline. */
  unified: boolean;
}

/** The built viewer, as contributions see it. */
export interface DiffViewerHost {
  readonly data: DiffData;
  readonly mode: DiffMode;
  /** Split: left and right; unified: one pane (`right`). */
  panes(): readonly DiffViewerPane[];
  /** Text of a side. */
  doc(side: DiffPaneSide): Text;
  /** The 0-based line of the other side matching `line` of `from` (across the changes between them). */
  mapLine(from: DiffPaneSide, line: number): number;
  /** The pane showing `line` of `side` and its line there (unified: left lines map to the right side). */
  locate(side: DiffPaneSide, line: number): { pane: DiffViewerPane; line: number } | null;
  /** Moves the caret to `line` of `side` and scrolls it to the middle, focusing that pane. */
  reveal(side: DiffPaneSide, line: number): void;
  /** The pane that had focus last. */
  focusedPane(): DiffViewerPane;
}

export interface DiffViewerContribution {
  /** Extensions of one pane, included each time the panes are built. */
  extensions?(pane: DiffPaneInfo): Extension;
  /** The panes were built; the returned function runs before they are destroyed. */
  attach?(host: DiffViewerHost): (() => void) | void;
  /** Rendered at the end of the diff toolbar (before the settings button). */
  Toolbar?: ComponentType<{ host: DiffViewerHost | null }>;
  /** Items appended to the viewer settings popup (⇧⌘D, the gear). */
  settingsItems?(): MenuItem[];
  /** Items of the panes' right-click menu for `line` (0-based) of `side`. */
  contextMenuItems?(at: { side: DiffPaneSide; line: number }): MenuItem[];
  dispose?(): void;
}

export interface DiffViewerProvider {
  id: string;
  /** A contribution for the diff, or null when the provider does not apply. */
  create(data: DiffData): DiffViewerContribution | null;
}

const providers = new Map<string, DiffViewerProvider>();

export function registerDiffViewerProvider(provider: DiffViewerProvider): () => void {
  providers.set(provider.id, provider);
  return () => {
    if (providers.get(provider.id) === provider) providers.delete(provider.id);
  };
}

/** The contributions of every provider that applies to `data`. */
export function createDiffViewerContributions(data: DiffData): DiffViewerContribution[] {
  const out: DiffViewerContribution[] = [];
  for (const p of providers.values()) {
    try {
      const c = p.create(data);
      if (c) out.push(c);
    } catch (e) {
      console.error(`diff viewer provider ${p.id} failed`, e);
    }
  }
  return out;
}
