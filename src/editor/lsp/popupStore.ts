/** State of the React popups the LSP editor features open (rendered by `Popups.tsx`). */
import { create } from "zustand";
import type { EditorView } from "@codemirror/view";
import type { Location, Markup } from "@/bindings";
import type { MenuItem } from "@/ui";
import type { WorkspaceEditSummary } from "./workspaceEdit";

export interface PopupPoint {
  x: number;
  y: number;
}

export interface ListPopupItem {
  id: string;
  label: string;
  /** Muted trailing text (file:line, kind…). */
  detail?: string;
  /** Second line / muted text after the label (code preview). */
  preview?: string;
  icon?: string;
  /** Symbol badge kind (`ui/icons` `SymbolBadge`) shown instead of an icon. */
  symbol?: string;
  emphasis?: boolean;
  /** Disabled reason; disabled rows are shown but not activatable. */
  disabled?: string | null;
  shortcut?: string;
  run: () => void | Promise<void>;
  /** IDEA's right-arrow menu of the row (inspection options of a fix). */
  submenu?: MenuItem[];
  /** Called when the row becomes the selected one (e.g. highlight what it would act on). */
  onActive?: () => void;
}

/** Side panel content for the selected row of a list popup (intention preview). */
export type ListPreview =
  | { kind: "diff"; lines: DiffLine[]; /** Other files the change touches. */ note?: string }
  | { kind: "text"; text: string };

export interface DiffLine {
  kind: "context" | "added" | "removed" | "gap";
  text: string;
}

export interface DocEntry {
  markup: Markup;
  language: string | null;
  /** Declaration of the documented element (Edit Source), resolved on demand. */
  source?: () => Promise<Location | null>;
}

export interface DefinitionTarget {
  location: Location;
  /** Name shown in the switcher (symbol or file name). */
  name: string;
  firstLine: number;
  text: string;
  language: string | null;
}

export interface ReformatOptions {
  selectionOnly: boolean;
  optimizeImports: boolean;
}

export type LspPopup =
  | {
      kind: "doc";
      anchor: PopupPoint;
      /** Navigation history (links followed inside the popup); `index` is shown. */
      entries: DocEntry[];
      index: number;
      themeClasses: string;
    }
  | {
      kind: "definition";
      anchor: PopupPoint;
      /** Every target (⌥Space on an overloaded / multiply defined symbol); `index` is shown. */
      targets: DefinitionTarget[];
      index: number;
      themeClasses: string;
    }
  | {
      kind: "list";
      anchor: PopupPoint;
      title: string;
      items: ListPopupItem[];
      /** Rows 1-9 get a number; typing it runs the row (IDEA's numbered popups). */
      numbered?: boolean;
      /** Header pin button (e.g. "Open in Find Tool Window"). */
      pin?: { label: string; run: () => void };
      /** Side panel for the selected row, fetched lazily; `signal` aborts when the selection moves. */
      preview?: (item: ListPopupItem, signal: AbortSignal) => Promise<ListPreview | null>;
      /** Runs when the popup goes away (closed, replaced or a row ran). */
      onClose?: () => void;
    }
  | {
      kind: "reformat";
      title: string;
      hasSelection: boolean;
      /** Whether the server offers Optimize Imports for the file. */
      canOptimizeImports: boolean;
      initial: ReformatOptions;
      onRun: (options: ReformatOptions) => void;
    }
  | {
      kind: "rename";
      anchor: PopupPoint;
      title: string;
      initial: string;
      /** Muted line under the input, e.g. that the rename is based on syntax only. */
      note?: string;
      /** Name suggestions listed under the input (↑↓ to pick), e.g. for Introduce Variable. */
      suggestions?: string[];
      /** Replaces the default "↵ Rename · Esc Cancel" footer. */
      hint?: string;
      onSubmit: (name: string) => void;
    }
  | {
      kind: "preview";
      title: string;
      summary: WorkspaceEditSummary;
      confirmLabel: string;
      onConfirm: () => void;
      /** Why confirmation is needed (shown as warnings above the changes). */
      warnings?: string[];
      /** Individual occurrences with line previews (single-file syntax-based renames). */
      occurrences?: PreviewOccurrence[];
    };

export interface PreviewOccurrence {
  line: number;
  /** The line's text and the occurrence within it. */
  text: string;
  from: number;
  to: number;
}

interface PopupState {
  popup: LspPopup | null;
  /** Bumped per open so React remounts a popup of the same kind. */
  seq: number;
  /** Bumped to move focus into the open popup (F1 on an open documentation popup). */
  focusSeq: number;
}

export const useLspPopup = create<PopupState>(() => ({ popup: null, seq: 0, focusSeq: 0 }));

export function focusPopup() {
  useLspPopup.setState((s) => ({ focusSeq: s.focusSeq + 1 }));
}

function disposed(popup: LspPopup | null) {
  if (popup?.kind === "list") popup.onClose?.();
}

export function openPopup(popup: LspPopup) {
  const previous = useLspPopup.getState().popup;
  useLspPopup.setState((s) => ({ popup, seq: s.seq + 1 }));
  if (previous !== popup) disposed(previous);
}

export function closePopup() {
  const previous = useLspPopup.getState().popup;
  useLspPopup.setState({ popup: null });
  disposed(previous);
}

/** Replaces the open popup's state without remounting it (doc history, definition switching). */
export function updatePopup<K extends LspPopup["kind"]>(kind: K, patch: Partial<Extract<LspPopup, { kind: K }>>): void {
  const current = useLspPopup.getState().popup;
  if (current?.kind !== kind) return;
  useLspPopup.setState({ popup: { ...current, ...patch } as LspPopup });
}

/** Screen point just below `pos` (falls back to the editor's top-left). */
export function caretAnchor(view: EditorView, pos: number, side: "below" | "above" = "below"): PopupPoint {
  const c = view.coordsAtPos(pos) ?? view.coordsAtPos(pos, -1);
  if (c) return { x: c.left, y: side === "below" ? c.bottom : c.top };
  const r = view.dom.getBoundingClientRect();
  return { x: r.left + 40, y: r.top + 40 };
}
