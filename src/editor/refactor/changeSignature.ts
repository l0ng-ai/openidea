/**
 * Change Signature (IDEA's Ctrl+F6) for servers that compute it in two steps:
 * the code action (`refactor.rewrite.changeSignature`) carries the current
 * signature as JSON in `data` and no edit; the dialog (`ChangeSignatureDialog.tsx`)
 * edits the parameter table, writes the new signature into `data.change` and has
 * the server resolve the action into the edit, which is applied as one change or
 * previewed first. The native PHP engine offers it (`ide_php::refactor::signature`).
 */
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { create } from "zustand";
import type { CodeAction, WorkspaceEdit } from "@/bindings";
import { commands, isCancelled, unavailableText } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { whenAllSynced, whenSynced } from "@/editor/api";
import { docOf, isUnavailable, lspRequest, reportLspError } from "@/editor/lsp/lsp";
import { openPopup } from "@/editor/lsp/popupStore";
import { summarizeWorkspaceEdit } from "@/editor/lsp/workspaceEdit";
import type { RefactorOutcome } from "./hierarchy";

/** One parameter, as the server sends and reads it. */
export interface SignatureParameter {
  /** Its position in the current signature; null for a new parameter. */
  oldIndex: number | null;
  /** Without the `$`. */
  name: string;
  type: string;
  defaultValue: string;
  /** New parameters: the argument existing calls pass. */
  callValue: string;
  byRef: boolean;
  variadic: boolean;
  /** A promoted constructor parameter (a property). */
  promoted: boolean;
}

export interface Signature {
  name: string;
  parameters: SignatureParameter[];
  returnType: string;
  constructor: boolean;
}

/** The action's `data`. */
export interface ChangeSignatureData {
  position: { line: number; col: number };
  signature: Signature;
  change: Signature | null;
}

export const CHANGE_SIGNATURE_KIND = "refactor.rewrite.changeSignature";

/** The signature an action offers to change, or null when it isn't such an action. */
export function changeSignatureData(action: Pick<CodeAction, "kind" | "data" | "edit">): ChangeSignatureData | null {
  if (action.edit || !action.kind?.startsWith(CHANGE_SIGNATURE_KIND) || typeof action.data !== "string") return null;
  try {
    const data = JSON.parse(action.data) as ChangeSignatureData;
    if (!data?.signature || !Array.isArray(data.signature.parameters) || !data.position) return null;
    return data;
  } catch {
    return null;
  }
}

/** A row of the dialog's parameter table. */
export interface ParamRow extends SignatureParameter {
  /** Stable React key. */
  key: string;
}

let rowSeq = 0;

export function initialRows(signature: Signature): ParamRow[] {
  return signature.parameters.map((p) => ({ ...p, key: `p${rowSeq++}` }));
}

export function newRow(): ParamRow {
  return {
    key: `p${rowSeq++}`,
    oldIndex: null,
    name: "",
    type: "",
    defaultValue: "",
    callValue: "",
    byRef: false,
    variadic: false,
    promoted: false,
  };
}

/** `rows` with row `i` moved by `delta` (no change at the ends). */
export function moveRow(rows: readonly ParamRow[], i: number, delta: number): ParamRow[] {
  const j = i + delta;
  if (i < 0 || i >= rows.length || j < 0 || j >= rows.length) return [...rows];
  const out = [...rows];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** How the parameter reads in the signature: `?int &...$name = 1`. */
export function parameterText(p: Pick<SignatureParameter, "type" | "byRef" | "variadic" | "name" | "defaultValue">) {
  const type = p.type.trim() ? `${p.type.trim()} ` : "";
  const value = p.defaultValue.trim() ? ` = ${p.defaultValue.trim()}` : "";
  return `${type}${p.byRef ? "&" : ""}${p.variadic ? "..." : ""}$${p.name.trim().replace(/^\$/, "")}${value}`;
}

/** The signature preview under the table. */
export function signatureText(name: string, rows: readonly ParamRow[], returnType: string): string {
  const ret = returnType.trim() ? `: ${returnType.trim()}` : "";
  return `${name}(${rows.map(parameterText).join(", ")})${ret}`;
}

/** What is wrong with the table before asking the server (it checks the rest), or null. */
export function rowProblem(rows: readonly ParamRow[]): string | null {
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const name = row.name.trim().replace(/^\$/, "");
    if (!name) return "Every parameter needs a name";
    if (seen.has(name)) return tx`There are two parameters named '$${name}'`;
    seen.add(name);
    if (row.variadic && i !== rows.length - 1) return tx`The variadic parameter '$${name}' must be the last one`;
    if (row.oldIndex === null && !row.variadic && !row.defaultValue.trim() && !row.callValue.trim())
      return tx`The new parameter '$${name}' needs a default value or a value for the existing calls`;
  }
  return null;
}

/** Whether the rows and return type differ from the signature. */
export function isChanged(signature: Signature, rows: readonly ParamRow[], returnType: string): boolean {
  if (returnType.trim() !== signature.returnType) return true;
  if (rows.length !== signature.parameters.length) return true;
  return rows.some((row, i) => {
    const p = signature.parameters[i]!;
    return (
      row.oldIndex !== i ||
      row.name.trim().replace(/^\$/, "") !== p.name ||
      row.type.trim() !== p.type ||
      row.defaultValue.trim() !== p.defaultValue ||
      row.byRef !== p.byRef ||
      row.variadic !== p.variadic
    );
  });
}

/** The new signature for the server. */
export function changeOf(signature: Signature, rows: readonly ParamRow[], returnType: string): Signature {
  return {
    ...signature,
    returnType: returnType.trim(),
    parameters: rows.map(({ key: _key, ...p }) => ({
      ...p,
      name: p.name.trim().replace(/^\$/, ""),
      type: p.type.trim(),
      defaultValue: p.defaultValue.trim(),
      callValue: p.oldIndex === null ? p.callValue.trim() : "",
    })),
  };
}

export interface ChangeSignatureRequest {
  seq: number;
  view: EditorView;
  doc: number;
  /** The document the action was computed for. */
  text: Text;
  action: CodeAction;
  data: ChangeSignatureData;
}

export const useChangeSignatureDialog = create<{ request: ChangeSignatureRequest | null }>(() => ({ request: null }));
let seq = 0;

/** Opens the dialog for the first action offering a signature; false when none does. */
export function startChangeSignature(view: EditorView, actions: readonly CodeAction[]): boolean {
  const ctx = docOf(view);
  if (!ctx) return false;
  for (const action of actions) {
    const data = changeSignatureData(action);
    if (!data) continue;
    useChangeSignatureDialog.setState({
      request: { seq: ++seq, view, doc: ctx.doc, text: view.state.doc, action, data },
    });
    return true;
  }
  return false;
}

function errorText(e: unknown): string {
  if (isUnavailable(e)) return unavailableText(e, "No language server available");
  return e instanceof Error ? e.message : String(e);
}

async function applyEdit(view: EditorView, edit: WorkspaceEdit) {
  try {
    await whenAllSynced();
    await lspRequest(() => commands.applyWorkspaceEdit(edit));
  } catch (e) {
    reportLspError(view, e, true);
  }
}

/**
 * Has the server compute the change and applies it, or opens the preview with
 * `preview`. The dialog stays open (with the reason) when the server refuses.
 */
export async function refactorChangeSignature(
  request: ChangeSignatureRequest,
  change: Signature,
  preview: boolean,
): Promise<RefactorOutcome> {
  const { view } = request;
  if (view.state.doc !== request.text) return { status: "stay", error: "The file changed; open the dialog again" };
  const action: CodeAction = { ...request.action, data: JSON.stringify({ ...request.data, change }) };
  let resolved: CodeAction;
  try {
    await whenSynced(view);
    resolved = await lspRequest(() => commands.lspResolveCodeAction(request.doc, action));
  } catch (e) {
    if (isCancelled(e)) return { status: "stay" };
    return { status: "stay", error: errorText(e) };
  }
  const edit = resolved.edit;
  const summary = edit ? summarizeWorkspaceEdit(edit) : null;
  if (!edit || !summary?.files) return { status: "stay", error: "Nothing to change" };
  if (preview) {
    openPopup({
      kind: "preview",
      title: tx`Change Signature of '${request.data.signature.name}'`,
      summary,
      confirmLabel: "Do Refactor",
      onConfirm: () => void applyEdit(view, edit),
    });
  } else {
    await applyEdit(view, edit);
  }
  return { status: "done" };
}
