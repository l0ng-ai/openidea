/** The Vim mode of the focused (or last focused) Vim editor, for the status bar widget. */
import { create } from "zustand";

export interface VimModeState {
  /** codemirror-vim's mode: `normal`, `insert`, `visual`, `replace`. */
  mode: string;
  /** Visual sub-mode. */
  sub: "linewise" | "blockwise" | null;
}

export const useVimMode = create<VimModeState>(() => ({ mode: "normal", sub: null }));

/** IdeaVim's widget text: NORMAL, INSERT, VISUAL, V-LINE, V-BLOCK, REPLACE. */
export function modeLabel({ mode, sub }: VimModeState): string {
  if (mode === "visual") return sub === "linewise" ? "V-LINE" : sub === "blockwise" ? "V-BLOCK" : "VISUAL";
  return (mode || "normal").toUpperCase();
}
