/**
 * Generate with a member chooser (IDEA's Generate › Getters…, Constructor…,
 * Override Methods…): the server's action (`source.generate.chooser`) carries
 * the members as JSON in `data` and no edit; the dialog
 * (`MemberChooserDialog.tsx`) picks the members, writes them into
 * `data.chosen` and has the server resolve the action into the edit. The
 * native PHP engine offers it (`ide_php::refactor::generate`).
 */
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { create } from "zustand";
import type { CodeAction } from "@/bindings";
import { commands, isCancelled, unavailableText } from "@/platform/ipc";
import { whenAllSynced, whenSynced } from "@/editor/api";
import { docOf, isUnavailable, lspRequest, reportLspError } from "@/editor/lsp/lsp";

export const GENERATE_CHOOSER_KIND = "source.generate.chooser";

/** One member the dialog lists. */
export interface ChooserMember {
  /** A property's name without `$`, a method's `Parent::name()`. */
  id: string;
  label: string;
  /** Its type, or a method's signature. */
  detail: string;
  /** Chosen when the dialog opens. */
  selected: boolean;
}

/** The action's `data`. */
export interface MemberChooserData {
  range: { start: { line: number; col: number }; end: { line: number; col: number } };
  generator: string;
  title: string;
  members: ChooserMember[];
  chosen: string[] | null;
}

/** The members an action offers, or null when it isn't a chooser action. */
export function memberChooserData(action: Pick<CodeAction, "kind" | "data" | "edit">): MemberChooserData | null {
  if (action.edit || action.kind !== GENERATE_CHOOSER_KIND || typeof action.data !== "string") return null;
  try {
    const data = JSON.parse(action.data) as MemberChooserData;
    if (!data || !Array.isArray(data.members) || typeof data.title !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

/** The dialog's title: the action's without the ellipsis. */
export function chooserTitle(data: MemberChooserData): string {
  return data.title.replace(/…$/, "");
}

/** The ids chosen when the dialog opens. */
export function initialChoice(data: MemberChooserData): string[] {
  return data.members.filter((m) => m.selected).map((m) => m.id);
}

/** `chosen` with `id` added or removed, in the members' order. */
export function toggled(data: MemberChooserData, chosen: readonly string[], id: string, on: boolean): string[] {
  const set = new Set(chosen);
  if (on) set.add(id);
  else set.delete(id);
  return data.members.map((m) => m.id).filter((m) => set.has(m));
}

export interface MemberChooserRequest {
  seq: number;
  view: EditorView;
  doc: number;
  /** The document the action was computed for. */
  text: Text;
  action: CodeAction;
  data: MemberChooserData;
}

export const useMemberChooser = create<{ request: MemberChooserRequest | null }>(() => ({ request: null }));
let seq = 0;

/** Opens the dialog when `action` is a chooser action; false otherwise. */
export function startMemberChooser(view: EditorView, action: Pick<CodeAction, "kind" | "data" | "edit">): boolean {
  const data = memberChooserData(action);
  const ctx = docOf(view);
  if (!data || !ctx) return false;
  useMemberChooser.setState({
    request: { seq: ++seq, view, doc: ctx.doc, text: view.state.doc, action: action as CodeAction, data },
  });
  return true;
}

export type ChooserOutcome = { status: "done" } | { status: "stay"; error?: string };

function errorText(e: unknown): string {
  if (isUnavailable(e)) return unavailableText(e, "No language server available");
  return e instanceof Error ? e.message : String(e);
}

/** Has the server generate the chosen members and applies the edit; the dialog stays (with the reason) when it refuses. */
export async function generateChosen(
  request: MemberChooserRequest,
  chosen: readonly string[],
): Promise<ChooserOutcome> {
  const { view } = request;
  if (view.state.doc !== request.text) return { status: "stay", error: "The file changed; open the dialog again" };
  const action: CodeAction = { ...request.action, data: JSON.stringify({ ...request.data, chosen: [...chosen] }) };
  let resolved: CodeAction;
  try {
    await whenSynced(view);
    resolved = await lspRequest(() => commands.lspResolveCodeAction(request.doc, action));
  } catch (e) {
    if (isCancelled(e)) return { status: "stay" };
    return { status: "stay", error: errorText(e) };
  }
  if (!resolved.edit) return { status: "stay", error: "Nothing to generate" };
  try {
    await whenAllSynced();
    await lspRequest(() => commands.applyWorkspaceEdit(resolved.edit!));
  } catch (e) {
    reportLspError(view, e, true);
  }
  return { status: "done" };
}
