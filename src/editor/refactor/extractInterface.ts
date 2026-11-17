/**
 * Extract Interface for Java: jdtls lists the members of the file's class and the packages, the
 * dialog (`ExtractInterfaceDialog.tsx`) picks the interface's name, package and members, and
 * jdtls creates the interface, makes the class implement it and uses it where possible.
 */
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { create } from "zustand";
import type { ExtractInterfaceInfo, InterfaceMember, Pos, ServerRefactored } from "@/bindings";
import { whenSynced } from "@/editor/api";
import { docOf, isUnavailable, lspRequest } from "@/editor/lsp/lsp";
import { offsetToPos } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { openPopup } from "@/editor/lsp/popupStore";
import { summarizeWorkspaceEdit } from "@/editor/lsp/workspaceEdit";
import { tx } from "@/platform/i18n";
import { commands, isCancelled, nextRequestId, unavailableText } from "@/platform/ipc";
import { editorService } from "@/workbench/contributions";
import { cannotPerform } from "./catalog";
import { JAVA_NAME, applyEdit, cancellable, confirmProblems } from "./signature";

/** Languages whose server extracts interfaces through the dialog. */
export const EXTRACT_INTERFACE_LANGUAGES = new Set(["java"]);

type Json = Record<string, unknown>;

/** A package the interface can go to; `json` is passed back to the server unchanged. */
export interface PackageChoice {
  name: string;
  path: string;
  current: boolean;
  json: string;
}

export function packageChoices(packages: readonly string[]): PackageChoice[] {
  return packages.map((json) => {
    const p = JSON.parse(json) as Json;
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    return {
      name: text(p.displayName) || "(default package)",
      path: text(p.path),
      current: !!p.isParentOfSelectedFile,
      json,
    };
  });
}

/** `area(double): double` for a method, `UNIT: int` for a field. */
export function memberLabel(m: InterfaceMember): string {
  const params = m.parameters ? `(${m.parameters.join(", ")})` : "";
  return `${m.name}${params}: ${m.typeName}`;
}

/** Why the interface can't be extracted yet, or null. */
export function interfaceProblem(name: string, className: string, members: number): string | null {
  if (!name) return "No interface name specified";
  if (!JAVA_NAME.test(name)) return "Interface name is not a valid identifier";
  if (name === className) return "Interface name should differ from the class name";
  if (!members) return "Select the members to form the interface";
  return null;
}

export interface InterfaceRequest {
  seq: number;
  view: EditorView;
  doc: number;
  pos: Pos;
  /** The document `pos` refers to. */
  text: Text;
  info: ExtractInterfaceInfo;
  packages: PackageChoice[];
}

export const useExtractInterfaceDialog = create<{ request: InterfaceRequest | null }>(() => ({ request: null }));
let seq = 0;
let running: AbortController | null = null;

function errorText(e: unknown): string {
  if (isUnavailable(e)) return unavailableText(e, "No language server available");
  return e instanceof Error ? e.message : String(e);
}

/** Extract Interface…: reads the file's class, then opens the dialog. */
export async function startExtractInterface(view: EditorView): Promise<void> {
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
    const info = await lspRequest(() => commands.lspExtractInterfaceInfo(request, ctx.doc, pos));
    if (run.signal.aborted || view.state.doc !== state.doc) return;
    if (!info.members.length) {
      showHint(view, cannotPerform("The class has no members to form an interface"));
      return;
    }
    const packages = packageChoices(info.packages);
    useExtractInterfaceDialog.setState({
      request: { seq: ++seq, view, doc: ctx.doc, pos, text: state.doc, info, packages },
    });
  } catch (e) {
    if (isCancelled(e) || run.signal.aborted) return;
    showHint(view, cannotPerform(errorText(e)));
  } finally {
    run.signal.removeEventListener("abort", abort);
    if (running === run) running = null;
  }
}

export type InterfaceOutcome = { status: "done" } | { status: "stay"; error?: string };

/** Checks the extraction, confirms its problems and applies the edit (opening the new interface), or previews it. */
export async function extractInterface(
  request: InterfaceRequest,
  name: string,
  pkg: PackageChoice,
  members: readonly string[],
  preview: boolean,
  /** The dialog closed: nothing is confirmed, previewed or applied any more. */
  signal?: AbortSignal,
): Promise<InterfaceOutcome> {
  const { view } = request;
  if (view.state.doc !== request.text) return { status: "stay", error: "The file changed; open the dialog again" };
  let confirmation: string | null = null;
  let extracted: ServerRefactored;
  try {
    for (;;) {
      await whenSynced(view);
      const token: string | null = confirmation;
      extracted = await cancellable(signal, (id, wanted) =>
        lspRequest(
          () => commands.lspExtractInterface(id, request.doc, request.pos, [...members], name, pkg.json, token),
          wanted,
        ),
      );
      if (signal?.aborted) return { status: "stay" };
      const fatal = extracted.problems.find((p) => p.severity === "fatal");
      if (fatal || (!extracted.edit && !extracted.confirmation))
        return { status: "stay", error: fatal?.message ?? "Nothing to change" };
      if (!extracted.confirmation) break;
      if (!(await confirmProblems(extracted.problems.map((p) => p.message))) || signal?.aborted)
        return { status: "stay" };
      confirmation = extracted.confirmation;
    }
  } catch (e) {
    if (isCancelled(e) || signal?.aborted) return { status: "stay" };
    return { status: "stay", error: errorText(e) };
  }
  const edit = extracted.edit!;
  const summary = summarizeWorkspaceEdit(edit);
  if (!summary.files) return { status: "stay", error: "Nothing to change" };
  const created = edit.files.find((f) => f.kind === "create")?.path;
  const apply = async (cancel?: AbortSignal) => {
    await applyEdit(view, edit, cancel);
    if (created && !cancel?.aborted) await editorService().openFile(created, { focus: true });
  };
  if (preview) {
    openPopup({
      kind: "preview",
      title: tx`Extract Interface from '${request.info.className}'`,
      summary,
      confirmLabel: "Do Refactor",
      onConfirm: () => void apply(),
    });
  } else {
    await apply(signal);
  }
  return { status: "done" };
}
