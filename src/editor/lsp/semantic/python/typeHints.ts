/**
 * PyCharm's "Add type hint for variable" and "Add type hints for function",
 * filled with the types the server infers: its type inlay hints carry the edit
 * that inserts them (and any import they need); a parameter's type comes from
 * hovering it, kept only when it names builtins, which need no import.
 */
import { syntaxTree } from "@codemirror/language";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { whenSynced, type ContributedIntention } from "@/editor/api";
import { commands, nextRequestId, type InlayHint, type TextEdit } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { docOf, lspRequest } from "../../lsp";
import { offsetToPos, offsetsToRange, posToOffset, textEditsToChanges } from "../../positions";

/** A name to annotate: the end of the name is where its annotation goes. */
interface Slot {
  end: number;
  /** For a defaulted parameter, where its value starts: `name=value` becomes `name: T = value` (PEP 8). */
  value?: number;
}

export type AnnotationTarget =
  | { kind: "variable"; slot: Slot }
  | { kind: "function"; name: string; header: { from: number; to: number }; returns: Slot | null; params: Slot[] };

/** The unannotated variable assignment or function header at `pos`. */
export function annotationTarget(tree: Tree, doc: Text, pos: number): AnnotationTarget | null {
  let start = tree.resolveInner(pos, 1);
  if (start.name !== "VariableName" && tree.resolveInner(pos, -1).name === "VariableName")
    start = tree.resolveInner(pos, -1);
  for (let n: SyntaxNode | null = start; n; n = n.parent) {
    if (n.name === "VariableName" && n.parent?.name === "AssignStatement") {
      const statement = n.parent;
      // Only `name = value`: an annotated, tuple or chained target takes no annotation.
      const simple =
        statement.firstChild?.from === n.from &&
        n.nextSibling?.name === "AssignOp" &&
        statement.getChildren("AssignOp").length === 1;
      return simple ? { kind: "variable", slot: { end: n.to } } : null;
    }
    if (n.name === "FunctionDefinition") {
      const params = n.getChild("ParamList");
      const body = n.getChild("Body");
      const name = n.getChild("VariableName");
      if (!params || !body || !name || pos > body.from) return null;
      const slots: Slot[] = [];
      let first = true;
      for (let c = params.firstChild; c; c = c.nextSibling) {
        if (c.name !== "VariableName") continue;
        const star = c.prevSibling?.name === "*" || c.prevSibling?.name === "**";
        if (!first && !star && c.nextSibling?.name === "AssignOp")
          slots.push({ end: c.to, value: c.nextSibling?.nextSibling?.from });
        first = false;
      }
      const returns = n.getChild("TypeDef") ? null : { end: params.to };
      return {
        kind: "function",
        name: doc.sliceString(name.from, name.to),
        header: { from: n.from, to: body.from },
        returns,
        params: slots,
      };
    }
    if (/Statement$|^Body$|^Script$/.test(n.name)) return null;
  }
  return null;
}

const BUILTINS = new Set([
  "int",
  "float",
  "complex",
  "bool",
  "str",
  "bytes",
  "bytearray",
  "list",
  "dict",
  "set",
  "frozenset",
  "tuple",
  "object",
  "None",
]);

/** The type in a hover such as `(parameter) count: int`, when it names only builtins. */
export function builtinHoverType(markdown: string): string | null {
  const m = /\((?:parameter|variable)\) [A-Za-z_]\w*: ([^\n`]+)/.exec(markdown);
  const type = m?.[1]?.trim();
  if (!type || type === "None") return null;
  const names = type.match(/[A-Za-z_][\w.]*/g) ?? [];
  return names.every((name) => BUILTINS.has(name)) ? type : null;
}

/** The type hint the server shows at `offset` with the edits that insert it. */
function hintAt(doc: Text, hints: readonly InlayHint[], offset: number, prefix: string): InlayHint | undefined {
  return hints.find(
    (h) =>
      h.kind === "type" && h.textEdits.length && h.label.startsWith(prefix) && posToOffset(doc, h.position) === offset,
  );
}

interface Annotation {
  label: string;
  edits: TextEdit[];
}

async function hoverAnnotation(view: EditorView, { end, value }: Slot): Promise<Annotation | null> {
  const doc = docOf(view)!;
  const hover = await lspRequest(() =>
    commands.lspHover(nextRequestId(), doc.doc, offsetToPos(view.state.doc, end - 1)),
  );
  const type = hover && builtinHoverType(hover.contents.value);
  if (!type) return null;
  const at = offsetsToRange(view.state.doc, end, value ?? end);
  return { label: `: ${type}`, edits: [{ range: at, new_text: value === undefined ? `: ${type}` : `: ${type} = ` }] };
}

function apply(view: EditorView, edits: readonly TextEdit[]): void {
  const unique = [...new Map(edits.map((e) => [JSON.stringify(e), e])).values()];
  view.dispatch({ changes: textEditsToChanges(view.state.doc, unique), userEvent: "input", scrollIntoView: true });
}

/** Annotation intentions at the caret, once the server answered. */
export async function pythonTypeHintIntentions(view: EditorView, signal: AbortSignal): Promise<ContributedIntention[]> {
  const doc = docOf(view);
  const selection = view.state.selection.main;
  if (doc?.uiMode !== "Python" || !selection.empty) return [];
  const state = view.state;
  const target = annotationTarget(syntaxTree(state), state.doc, selection.head);
  if (!target) return [];
  await whenSynced(view);
  const line = state.doc.lineAt(selection.head);
  const span = target.kind === "function" ? target.header : { from: line.from, to: line.to };
  const hints = await lspRequest(() =>
    commands.lspInlayHints(doc.doc, offsetsToRange(state.doc, span.from, span.to)),
  ).catch(() => [] as InlayHint[]);
  if (signal.aborted || view.state.doc !== state.doc) return [];
  const fromHint = (h: InlayHint | undefined): Annotation | null =>
    h ? { label: h.label.trim(), edits: h.textEdits } : null;

  if (target.kind === "variable") {
    const found =
      fromHint(hintAt(state.doc, hints, target.slot.end, ":")) ??
      (await hoverAnnotation(view, target.slot).catch(() => null));
    if (!found || signal.aborted || view.state.doc !== state.doc) return [];
    const annotation = found.label;
    return [
      {
        id: "python.addVariableType",
        label: tx`Add type annotation '${annotation}'`,
        icon: "bulb",
        run: () => apply(view, found.edits),
      },
    ];
  }

  const returns = target.returns && fromHint(hintAt(state.doc, hints, target.returns.end, "->"));
  const params = (await Promise.all(target.params.map((p) => hoverAnnotation(view, p).catch(() => null)))).filter(
    (a): a is Annotation => !!a,
  );
  if (signal.aborted || view.state.doc !== state.doc) return [];
  const out: ContributedIntention[] = [];
  if (returns) {
    const annotation = returns.label;
    out.push({
      id: "python.addReturnType",
      label: tx`Add return type annotation '${annotation}'`,
      icon: "bulb",
      run: () => apply(view, returns.edits),
    });
  }
  if (params.length) {
    const name = target.name;
    const edits = [...(returns?.edits ?? []), ...params.flatMap((p) => p.edits)];
    out.push({
      id: "python.addFunctionTypes",
      label: tx`Add type hints for function '${name}'`,
      icon: "bulb",
      run: () => apply(view, edits),
    });
  }
  return out;
}
