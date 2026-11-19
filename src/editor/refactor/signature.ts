/**
 * Change Signature (⌘F6) for Java: jdtls reads the method at the caret, the dialog
 * (`ChangeSignatureDialog.tsx`) edits its visibility, return type, name and parameters, and
 * jdtls checks the new signature and computes the edit for the method, its overrides and
 * every call. Problems are confirmed like IDEA's "Problems Detected".
 */
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { create } from "zustand";
import type { MethodSignature, Pos, ServerRefactored, SignatureParameter, WorkspaceEdit } from "@/bindings";
import { whenAllSynced, whenSynced } from "@/editor/api";
import { docOf, isUnavailable, lspRequest, reportLspError } from "@/editor/lsp/lsp";
import { offsetToPos } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { openPopup } from "@/editor/lsp/popupStore";
import { summarizeWorkspaceEdit } from "@/editor/lsp/workspaceEdit";
import { tx } from "@/platform/i18n";
import { IpcError, commands, isCancelled, nextRequestId, unavailableText } from "@/platform/ipc";
import { ask } from "@/workbench/messages";
import { cannotPerform } from "./catalog";

/** Languages whose server changes signatures through the dialog. */
export const SIGNATURE_LANGUAGES = new Set(["java"]);

/** IDEA's visibility choices; jdtls spells package-private as the empty string. */
export const VISIBILITIES = ["public", "protected", "", "private"] as const;

/** A parameter row; `key` keeps React rows stable while they move. */
export interface ParameterRow extends SignatureParameter {
  key: number;
}

let rowKeys = 0;
export const parameterRow = (p: SignatureParameter): ParameterRow => ({ ...p, key: ++rowKeys });
/** IDEA's new parameter: an empty type and name, `null` passed at existing calls. */
export const newParameter = (): ParameterRow =>
  parameterRow({ type: "", name: "", defaultValue: "", originalIndex: -1 });

/** Formats the declaration for the dialog's preview. */
export function signatureText(sig: {
  modifier: string;
  returnType: string;
  methodName: string;
  parameters: readonly SignatureParameter[];
  exceptions?: readonly { type: string }[];
}): string {
  const params = sig.parameters.map((p) => `${p.type} ${p.name}`.trim());
  const args = params.length > 1 ? `\n    ${params.join(",\n    ")}\n` : (params[0] ?? "");
  const head = [sig.modifier, sig.returnType, `${sig.methodName}(${args})`].filter(Boolean).join(" ");
  const throws = sig.exceptions?.length ? ` throws ${sig.exceptions.map((e) => e.type).join(", ")}` : "";
  return head + throws;
}

/** A Java identifier: letters of any script, `$` and `_`, then digits and combining marks too. */
export const JAVA_NAME = /^[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}]*$/u;

/** Why the edited signature can't be submitted yet, or null. */
export function signatureProblem(sig: MethodSignature): string | null {
  if (!JAVA_NAME.test(sig.methodName)) return "Method name is not a valid identifier";
  if (!sig.returnType.trim()) return "Return type is not specified";
  const seen = new Set<string>();
  for (const p of sig.parameters) {
    if (!p.type.trim()) return "Parameter type is not specified";
    if (!JAVA_NAME.test(p.name)) return "Parameter name is not a valid identifier";
    if (seen.has(p.name)) return "Duplicate parameter name";
    seen.add(p.name);
    if (p.originalIndex < 0 && !p.defaultValue.trim()) return "Default value is not specified for a new parameter";
  }
  return null;
}

/** Whether `sig` differs from the method's current signature. */
export function signatureChanged(original: MethodSignature, sig: MethodSignature): boolean {
  const same = (a: SignatureParameter, b: SignatureParameter) =>
    a.type === b.type && a.name === b.name && a.originalIndex === b.originalIndex;
  return (
    original.modifier !== sig.modifier ||
    original.returnType !== sig.returnType ||
    original.methodName !== sig.methodName ||
    original.parameters.length !== sig.parameters.length ||
    original.parameters.some((p, i) => !same(p, sig.parameters[i]!))
  );
}

export interface SignatureRequest {
  seq: number;
  view: EditorView;
  doc: number;
  pos: Pos;
  /** The document `pos` refers to. */
  text: Text;
  info: MethodSignature;
}

export const useSignatureDialog = create<{ request: SignatureRequest | null }>(() => ({ request: null }));
let seq = 0;
let running: AbortController | null = null;

function errorText(e: unknown): string {
  if (isUnavailable(e)) return unavailableText(e, "No language server available");
  return e instanceof Error ? e.message : String(e);
}

/** Change Signature…: reads the method at the caret, then opens the dialog. */
export async function startChangeSignature(view: EditorView): Promise<void> {
  const ctx = docOf(view);
  if (!ctx) return;
  if (ctx.readOnly) {
    showHint(view, cannotPerform("The file is read-only"));
    return;
  }
  running?.abort();
  const run = (running = new AbortController());
  await whenSynced(view);
  const state = view.state;
  const pos = offsetToPos(state.doc, state.selection.main.head);
  const request = nextRequestId();
  const abort = () => void commands.cancelRequest(request);
  run.signal.addEventListener("abort", abort);
  try {
    const info = await lspRequest(() => commands.lspSignatureInfo(request, ctx.doc, pos));
    if (run.signal.aborted || view.state.doc !== state.doc) return;
    useSignatureDialog.setState({ request: { seq: ++seq, view, doc: ctx.doc, pos, text: state.doc, info } });
  } catch (e) {
    if (isCancelled(e) || run.signal.aborted) return;
    showHint(view, cannotPerform(errorText(e)));
  } finally {
    run.signal.removeEventListener("abort", abort);
    if (running === run) running = null;
  }
}

export async function applyEdit(view: EditorView, edit: WorkspaceEdit, signal?: AbortSignal) {
  try {
    await whenAllSynced();
    // The dialog closed while the editors were syncing: nothing is applied.
    if (signal?.aborted) return;
    await lspRequest(
      () => commands.applyWorkspaceEdit(edit),
      () => !signal?.aborted,
    );
  } catch (e) {
    reportLspError(view, e, true);
  }
}

/**
 * Sends `send(id, wanted)` with a fresh request id that `signal` cancels. `wanted` goes to
 * `lspRequest`, which syncs editors first: a dialog closed meanwhile never sends the request.
 */
export async function cancellable<T>(
  signal: AbortSignal | undefined,
  send: (id: number, wanted: () => boolean) => Promise<T>,
): Promise<T> {
  // Closed before the request went out: it never does (a cancel can't reach an unsent request).
  if (signal?.aborted) throw new IpcError({ kind: "cancelled", message: "Cancelled" });
  const id = nextRequestId();
  const abort = () => void commands.cancelRequest(id);
  signal?.addEventListener("abort", abort);
  try {
    return await send(id, () => !signal?.aborted);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export async function confirmProblems(messages: readonly string[]): Promise<boolean> {
  const { button } = await ask({
    title: "Problems Detected",
    icon: "warning",
    body: messages.join("\n"),
    buttons: [
      { id: "continue", label: "Continue", primary: true },
      { id: "cancel", label: "Cancel" },
    ],
  });
  return button === "continue";
}

export type SignatureOutcome = { status: "done" } | { status: "stay"; error?: string };

/** Checks the new signature, confirms its problems and applies the edit, or previews it with `preview`. */
export async function changeSignature(
  request: SignatureRequest,
  signature: MethodSignature,
  delegate: boolean,
  preview: boolean,
  /** The dialog closed: nothing is confirmed, previewed or applied any more. */
  signal?: AbortSignal,
): Promise<SignatureOutcome> {
  const { view } = request;
  if (view.state.doc !== request.text) return { status: "stay", error: "The file changed; open the dialog again" };
  let confirmation: string | null = null;
  let changed: ServerRefactored;
  try {
    for (;;) {
      await whenSynced(view);
      const token: string | null = confirmation;
      changed = await cancellable(signal, (id, wanted) =>
        lspRequest(() => commands.lspChangeSignature(id, request.doc, request.pos, signature, delegate, token), wanted),
      );
      if (signal?.aborted) return { status: "stay" };
      const fatal = changed.problems.find((p) => p.severity === "fatal");
      if (fatal || (!changed.edit && !changed.confirmation))
        return { status: "stay", error: fatal?.message ?? "Nothing to change" };
      if (!changed.confirmation) break;
      if (!(await confirmProblems(changed.problems.map((p) => p.message))) || signal?.aborted)
        return { status: "stay" };
      confirmation = changed.confirmation;
    }
  } catch (e) {
    if (isCancelled(e) || signal?.aborted) return { status: "stay" };
    return { status: "stay", error: errorText(e) };
  }
  const edit = changed.edit!;
  const summary = summarizeWorkspaceEdit(edit);
  if (!summary.files) return { status: "stay", error: "Nothing to change" };
  if (preview) {
    openPopup({
      kind: "preview",
      title: tx`Change Signature of '${request.info.methodName}'`,
      summary,
      confirmLabel: "Do Refactor",
      onConfirm: () => void applyEdit(view, edit),
    });
  } else {
    await applyEdit(view, edit, signal);
  }
  return { status: "done" };
}
