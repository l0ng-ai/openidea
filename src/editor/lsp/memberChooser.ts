/**
 * IDEA's member chooser ("Select Methods to Override", "Choose Fields to Initialize"): a dialog
 * with the members grouped by the class declaring them; resolves with the chosen ids in list
 * order, or null when cancelled.
 */
import type { EditorView } from "@codemirror/view";
import { create } from "zustand";

export interface ChooserMember {
  id: string;
  label: string;
  /** Muted text after the label (the signature). */
  detail?: string;
  icon: string;
  /** Heading of the members' group (the declaring class). */
  group?: string;
}

export interface MemberChooserRequest {
  seq: number;
  title: string;
  members: ChooserMember[];
  view: EditorView;
  resolve: (ids: string[] | null) => void;
}

export const useMemberChooser = create<{ request: MemberChooserRequest | null }>(() => ({ request: null }));

let seq = 0;

export function chooseMembers(
  view: EditorView,
  { title, members }: { title: string; members: ChooserMember[] },
): Promise<string[] | null> {
  useMemberChooser.getState().request?.resolve(null);
  return new Promise((resolve) => {
    useMemberChooser.setState({ request: { seq: ++seq, title, members, view, resolve } });
  });
}
