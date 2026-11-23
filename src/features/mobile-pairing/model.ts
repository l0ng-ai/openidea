/** Pair Mobile Device: whether the dialog is open. */
import { create } from "zustand";

export const usePairDialog = create<{ open: boolean }>(() => ({ open: false }));

export function openPairDialog() {
  usePairDialog.setState({ open: true });
}

export function closePairDialog() {
  usePairDialog.setState({ open: false });
}

/** `m:ss` for a countdown of `seconds`. */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
