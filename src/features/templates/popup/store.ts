/** State of the caret-anchored chooser (⌘J, Surround With, postfix expression). */
import { create } from "zustand";

export interface ChooserItem {
  key: string;
  label: string;
  detail?: string;
  /** Matched against the filter in addition to the label. */
  search?: string;
  /** A section header row ("Live templates"); not selectable. */
  section?: boolean;
  /** Typing this character picks the item (see `ChooserRequest.mnemonics`). */
  mnemonic?: string;
  /** Where the mnemonic is underlined in the label. Omit for a separate leading column. */
  mnemonicIndex?: number;
}

export interface ChooserRequest {
  title: string;
  anchor: { x: number; y: number };
  items: ChooserItem[];
  /** Initial filter (typed prefix for ⌘J). */
  filter?: string;
  /** Allow typing to filter. */
  filterable?: boolean;
  /** Typed characters pick items by `mnemonic` (instead of filtering). */
  mnemonics?: boolean;
  /** Shown when nothing matches. */
  emptyText?: string;
  onPick: (item: ChooserItem, filter: string) => void;
  onCancel?: () => void;
}

export const useChooser = create<{ request: ChooserRequest | null; seq: number }>(() => ({ request: null, seq: 0 }));

export function showChooser(r: ChooserRequest) {
  const prev = useChooser.getState().request;
  prev?.onCancel?.();
  useChooser.setState((s) => ({ request: r, seq: s.seq + 1 }));
}

export function closeChooser() {
  useChooser.setState({ request: null });
}
