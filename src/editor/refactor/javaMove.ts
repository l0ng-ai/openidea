/**
 * Java Move (F6) and Change Signature from jdtls' client-side refactoring command
 * (`java.action.applyRefactoringCommand`): Move asks for the destination (a package, a class,
 * or the field or parameter an instance method moves to), then jdtls checks the move and
 * computes the edit, which is applied as one change after its problems are confirmed.
 */
import type { EditorView } from "@codemirror/view";
import type { ServerRefactored } from "@/bindings";
import { whenSynced } from "@/editor/api";
import { docOf, isUnavailable, lspRequest } from "@/editor/lsp/lsp";
import { showHint } from "@/editor/lsp/hint";
import { caretAnchor, openPopup, type ListPopupItem } from "@/editor/lsp/popupStore";
import { tx } from "@/platform/i18n";
import { commands, isCancelled, nextRequestId, unavailableText } from "@/platform/ipc";
import { cannotPerform } from "./catalog";
import { applyEdit, confirmProblems, startChangeSignature } from "./signature";

export const JAVA_REFACTORING_COMMAND = "java.action.applyRefactoringCommand";

type Json = Record<string, unknown>;
const record = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const text = (v: unknown): string => (typeof v === "string" ? v : "");
/** The file of the code action's parameters. */
const sourceOf = (params: unknown): string[] => {
  const uri = text(record(record(params).textDocument).uri);
  return uri ? [uri] : [];
};

/** What a Move request sends: the code action's parameters, its file and the destination. */
export interface MoveRequest {
  sourceUris: string[];
  params: unknown;
  destination?: unknown;
}

/** A package from `java/getMoveDestinations` (moveResource) as a chooser row. */
export function packageRow(p: Json): { label: string; detail: string; current: boolean } {
  return {
    label: text(p.displayName) || "(default package)",
    detail: text(p.path),
    current: !!p.isParentOfSelectedFile,
  };
}

/** The classes a member or type can move into: every source type but its own and itself, by name. */
export function targetTypes(types: readonly unknown[], exclude: ReadonlySet<string>): Json[] {
  return types
    .map(record)
    .filter((t) => {
      const name = text(t.name);
      const container = text(t.containerName);
      return name && !exclude.has(container ? `${container}.${name}` : name);
    })
    .sort((a, b) => text(a.name).localeCompare(text(b.name)));
}

function errorText(e: unknown): string {
  if (isUnavailable(e)) return unavailableText(e, "No language server available");
  return e instanceof Error ? e.message : String(e);
}

function choose(view: EditorView, title: string, items: ListPopupItem[]) {
  openPopup({ kind: "list", anchor: caretAnchor(view, view.state.selection.main.head), title, items });
}

/** Asks jdtls to move, confirming its warnings, and applies the edit. */
async function move(view: EditorView, kind: string, request: MoveRequest) {
  const ctx = docOf(view);
  if (!ctx) return;
  let confirmation: string | null = null;
  let moved: ServerRefactored;
  try {
    for (;;) {
      await whenSynced(view);
      const token: string | null = confirmation;
      moved = await lspRequest(() =>
        commands.lspJavaMove(nextRequestId(), ctx.doc, kind, JSON.stringify(request), token),
      );
      const fatal = moved.problems.find((p) => p.severity === "fatal");
      if (fatal || (!moved.edit && !moved.confirmation)) {
        showHint(view, cannotPerform(fatal?.message ?? "Nothing to change"));
        return;
      }
      if (!moved.confirmation) break;
      if (!(await confirmProblems(moved.problems.map((p) => p.message)))) return;
      confirmation = moved.confirmation;
    }
  } catch (e) {
    if (!isCancelled(e)) showHint(view, cannotPerform(errorText(e)));
    return;
  }
  await applyEdit(view, moved.edit!);
}

async function destinations(view: EditorView, kind: string, request: MoveRequest): Promise<Json[] | null> {
  const ctx = docOf(view);
  if (!ctx) return null;
  try {
    const found = await lspRequest(() =>
      commands.lspJavaMoveDestinations(nextRequestId(), ctx.doc, kind, JSON.stringify(request)),
    );
    return found.map((d) => record(JSON.parse(d)));
  } catch (e) {
    if (!isCancelled(e)) showHint(view, cannotPerform(errorText(e)));
    return null;
  }
}

async function chooseClass(view: EditorView, title: string, info: Json, exclude: Set<string>, run: (t: Json) => void) {
  const ctx = docOf(view);
  if (!ctx) return;
  let types: unknown[];
  try {
    const project = text(info.projectName) || null;
    const found = await lspRequest(() => commands.lspJavaSourceTypes(nextRequestId(), ctx.doc, project));
    types = found.map((t) => JSON.parse(t) as unknown);
  } catch (e) {
    if (!isCancelled(e)) showHint(view, cannotPerform(errorText(e)));
    return;
  }
  const targets = targetTypes(types, exclude);
  if (!targets.length) {
    showHint(view, cannotPerform("No classes to move to"));
    return;
  }
  choose(
    view,
    title,
    targets.map((t, i) => ({
      id: `${i}`,
      label: text(t.name),
      detail: text(t.containerName),
      symbol: "class",
      run: () => run(t),
    })),
  );
}

async function moveFile(view: EditorView, info: Json) {
  const uri = text(info.uri);
  if (!uri) return;
  const request: MoveRequest = { sourceUris: [uri], params: null };
  const packages = await destinations(view, "moveResource", request);
  if (!packages) return;
  if (!packages.length) {
    showHint(view, cannotPerform("No packages to move the file to"));
    return;
  }
  const name = decodeURIComponent(uri.slice(uri.lastIndexOf("/") + 1));
  choose(
    view,
    tx`Move ${name} to Package`,
    packages.map((p, i) => {
      const row = packageRow(p);
      return {
        id: `${i}`,
        label: row.label,
        detail: row.detail,
        icon: "package",
        disabled: row.current ? tx("Current package") : null,
        run: () => void move(view, "moveResource", { ...request, destination: p }),
      };
    }),
  );
}

async function moveInstanceMethod(view: EditorView, params: unknown, info: Json) {
  const request: MoveRequest = { sourceUris: sourceOf(params), params };
  const targets = await destinations(view, "moveInstanceMethod", request);
  if (!targets) return;
  if (!targets.length) {
    showHint(view, cannotPerform("No fields or parameters to move the method to"));
    return;
  }
  choose(
    view,
    tx`Move Instance Method ${text(info.displayName)}`,
    targets.map((d, i) => ({
      id: `${i}`,
      label: `${text(d.type)} ${text(d.name)}`,
      detail: d.isField ? tx("Field") : tx("Parameter"),
      run: () => void move(view, "moveInstanceMethod", { ...request, destination: d }),
    })),
  );
}

function excluded(info: Json, nestedType: boolean): Set<string> {
  const exclude = new Set<string>();
  const enclosing = text(info.enclosingTypeName);
  if (enclosing) {
    exclude.add(enclosing);
    if (nestedType) exclude.add(`${enclosing}.${text(info.displayName)}`);
  }
  return exclude;
}

async function moveStaticMember(view: EditorView, params: unknown, info: Json) {
  // 55, 71, 81: a class, enum or annotation type (JDT element kinds).
  const nested = [55, 71, 81].includes(Number(info.memberType));
  await chooseClass(
    view,
    tx`Move ${text(info.displayName)} to Class`,
    info,
    excluded(info, nested),
    (t) => void move(view, "moveStaticMember", { sourceUris: sourceOf(params), params, destination: t }),
  );
}

async function moveType(view: EditorView, params: unknown, info: Json) {
  const name = text(info.displayName);
  const kinds = Array.isArray(info.supportedDestinationKinds) ? info.supportedDestinationKinds.map(text) : [];
  const request: MoveRequest = { sourceUris: sourceOf(params), params };
  const toClass = () =>
    chooseClass(
      view,
      tx`Move ${name} to Class`,
      info,
      excluded(info, true),
      (t) => void move(view, "moveTypeToClass", { ...request, destination: t }),
    );
  const items: ListPopupItem[] = [];
  if (kinds.includes("newFile"))
    items.push({
      id: "file",
      label: tx`Move ${name} to a new file`,
      run: () => void move(view, "moveTypeToNewFile", request),
    });
  if (kinds.includes("class"))
    items.push({ id: "class", label: tx`Move ${name} to another class`, run: () => void toClass() });
  if (items.length === 1) return void items[0]!.run();
  if (items.length) choose(view, tx("Move"), items);
}

/** `java.action.applyRefactoringCommand`: the refactorings jdtls leaves to the client. */
export async function runJavaRefactoringCommand(view: EditorView, args: readonly unknown[]): Promise<boolean> {
  const [command, params, info] = [text(args[0]), args[1], record(args[2])];
  switch (command) {
    case "changeSignature":
      await startChangeSignature(view);
      return true;
    case "moveFile":
      await moveFile(view, info);
      return true;
    case "moveInstanceMethod":
      await moveInstanceMethod(view, params, info);
      return true;
    case "moveStaticMember":
      await moveStaticMember(view, params, info);
      return true;
    case "moveType":
      await moveType(view, params, info);
      return true;
    default:
      return false;
  }
}
