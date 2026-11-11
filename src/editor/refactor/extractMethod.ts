/**
 * Extract Method (IDEA's ⌥⌘M) with its dialog, for servers that compute it in
 * two steps: the code action (`refactor.extract.method.dialog`) carries the
 * defaults as JSON in `data` and no edit; the dialog (`ExtractMethodDialog.tsx`)
 * chooses the name, the parameters (renamed, reordered, excluded), the
 * visibility, `static`, the return type and whether duplicates are replaced,
 * writes that into `data.change` and has the server resolve the action into
 * the edit, which is applied or previewed first. The native PHP engine offers
 * it (`ide_php::refactor::method`).
 */
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { create } from "zustand";
import type { CodeAction, Range, WorkspaceEdit } from "@/bindings";
import { commands, isCancelled, unavailableText } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { whenAllSynced, whenSynced } from "@/editor/api";
import { docOf, isUnavailable, lspRequest, reportLspError } from "@/editor/lsp/lsp";
import { openPopup } from "@/editor/lsp/popupStore";
import { summarizeWorkspaceEdit } from "@/editor/lsp/workspaceEdit";
import type { RefactorOutcome } from "./hierarchy";

/** One parameter of the new method, as the server sends and reads it. */
export interface ExtractParameter {
  /** The variable in the selection, without `$`. */
  oldName: string;
  /** Its name in the new method, without `$`. */
  name: string;
  type: string;
  /** Passed; an excluded one is left undefined in the new body. */
  included: boolean;
}

export type Visibility = "private" | "protected" | "public";

export interface ExtractChoice {
  name: string;
  parameters: ExtractParameter[];
  returnType: string;
  /** Methods only. */
  visibility: Visibility | "";
  static: boolean;
  replaceDuplicates: boolean;
}

/** The action's `data`. */
export interface ExtractMethodData {
  range: Range;
  /** A function: no visibility or `static`. */
  function: boolean;
  /** The class the method goes in; empty for a function. */
  className: string;
  defaults: ExtractChoice;
  /** The method has to be static. */
  staticRequired: boolean;
  /** The code uses `$this`: the method can't be static. */
  usesThis: boolean;
  /** Copies of the code the call can replace too. */
  duplicates: number;
  change: ExtractChoice | null;
}

export const EXTRACT_METHOD_DIALOG_KIND = "refactor.extract.method.dialog";

/** The defaults an action offers, or null when it isn't the dialog's action. */
export function extractMethodData(action: Pick<CodeAction, "kind" | "data" | "edit">): ExtractMethodData | null {
  if (action.edit || action.kind !== EXTRACT_METHOD_DIALOG_KIND || typeof action.data !== "string") return null;
  try {
    const data = JSON.parse(action.data) as ExtractMethodData;
    if (!data?.defaults || !Array.isArray(data.defaults.parameters) || !data.range) return null;
    return data;
  } catch {
    return null;
  }
}

/** `params` with parameter `i` moved by `delta` (no change at the ends). */
export function moveParameter(params: readonly ExtractParameter[], i: number, delta: number): ExtractParameter[] {
  const j = i + delta;
  if (i < 0 || i >= params.length || j < 0 || j >= params.length) return [...params];
  const out = [...params];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

const IDENTIFIER = /^[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*$/;
const bare = (name: string) => name.trim().replace(/^\$/, "");

/** What is wrong with the choice before asking the server (it checks the rest), or null. */
export function choiceProblem(choice: ExtractChoice): string | null {
  const name = choice.name.trim();
  if (!name) return "Enter a name";
  if (!IDENTIFIER.test(name)) return tx`'${name}' is not a valid name`;
  const seen = new Set<string>();
  for (const p of choice.parameters) {
    if (!p.included) continue;
    const param = bare(p.name);
    if (!param) return "Every parameter needs a name";
    if (!IDENTIFIER.test(param) || param === "this") return tx`'$${param}' is not a valid parameter name`;
    if (seen.has(param)) return tx`There are two parameters named '$${param}'`;
    seen.add(param);
  }
  return null;
}

/** The declaration preview: `private static function name(int $a, $b): int`. */
export function declarationText(data: ExtractMethodData, choice: ExtractChoice): string {
  const params = choice.parameters
    .filter((p) => p.included)
    .map((p) => `${p.type.trim() ? `${p.type.trim()} ` : ""}$${bare(p.name)}`)
    .join(", ");
  const ret = choice.returnType.trim() ? `: ${choice.returnType.trim()}` : "";
  const modifiers = data.function ? "function" : `${choice.visibility}${choice.static ? " static" : ""} function`;
  return `${modifiers} ${choice.name.trim()}(${params})${ret}`;
}

/** The choice as the server reads it (trimmed, names without `$`). */
export function cleanChoice(choice: ExtractChoice): ExtractChoice {
  return {
    ...choice,
    name: choice.name.trim(),
    returnType: choice.returnType.trim(),
    parameters: choice.parameters.map((p) => ({ ...p, name: bare(p.name), type: p.type.trim() })),
  };
}

export interface ExtractMethodRequest {
  seq: number;
  view: EditorView;
  doc: number;
  /** The document the action was computed for. */
  text: Text;
  action: CodeAction;
  data: ExtractMethodData;
}

export const useExtractMethodDialog = create<{ request: ExtractMethodRequest | null }>(() => ({ request: null }));
let seq = 0;

/** Opens the dialog for the first action offering it; false when none does. */
export function startExtractMethod(view: EditorView, actions: readonly CodeAction[]): boolean {
  const ctx = docOf(view);
  if (!ctx) return false;
  for (const action of actions) {
    const data = extractMethodData(action);
    if (!data) continue;
    useExtractMethodDialog.setState({
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
 * Has the server compute the extraction and applies it, or opens the preview
 * with `preview`. The dialog stays open (with the reason) when the server
 * refuses.
 */
export async function refactorExtractMethod(
  request: ExtractMethodRequest,
  choice: ExtractChoice,
  preview: boolean,
): Promise<RefactorOutcome> {
  const { view } = request;
  if (view.state.doc !== request.text) return { status: "stay", error: "The file changed; open the dialog again" };
  const action: CodeAction = { ...request.action, data: JSON.stringify({ ...request.data, change: choice }) };
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
      title: request.data.function ? tx`Extract Function '${choice.name}'` : tx`Extract Method '${choice.name}'`,
      summary,
      confirmLabel: "Do Refactor",
      onConfirm: () => void applyEdit(view, edit),
    });
  } else {
    await applyEdit(view, edit);
  }
  return { status: "done" };
}
