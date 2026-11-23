/**
 * PyCharm's "Add type hint for variable" and "Add type hints for function",
 * filled with the types the server infers: its type inlay hints carry the edit
 * that inserts them (and any import they need); a parameter's type comes from
 * hovering it, kept only when it names builtins, which need no import.
 * Annotations Python evaluates (signatures, module variables) use `X | Y` and
 * `list[X]` only when `requires-python` or `from __future__ import annotations`
 * allows them.
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
import { readFileLines } from "../../files";
import { useProject } from "@/platform/project";

/** A name to annotate: the end of the name is where its annotation goes. */
interface Slot {
  end: number;
  /** For a defaulted parameter, where its value starts: `name=value` becomes `name: T = value` (PEP 8). */
  value?: number;
}

export type AnnotationTarget =
  /** `evaluated`: a module variable, whose annotation runs at import; a local's never runs. */
  | { kind: "variable"; slot: Slot; evaluated: boolean }
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
      if (!simple) return null;
      const scope = scopeOf(statement);
      // A class body's annotated name becomes a field (dataclass, NamedTuple, pydantic…).
      if (scope?.name !== "FunctionDefinition" && scope?.name !== "Script") return null;
      if (declaredGlobal(scope, doc, doc.sliceString(n.from, n.to))) return null;
      return { kind: "variable", slot: { end: n.to }, evaluated: scope.name === "Script" };
    }
    if (n.name === "FunctionDefinition") {
      const params = n.getChild("ParamList");
      const body = n.getChild("Body");
      const name = n.getChild("VariableName");
      if (!params || !body || !name || pos > body.from) return null;
      const slots: Slot[] = [];
      // Only defaulted parameters: `self` / `cls` have no default.
      for (let c = params.firstChild; c; c = c.nextSibling) {
        if (c.name !== "VariableName") continue;
        const star = c.prevSibling?.name === "*" || c.prevSibling?.name === "**";
        if (!star && c.nextSibling?.name === "AssignOp")
          slots.push({ end: c.to, value: c.nextSibling?.nextSibling?.from });
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

/** The function, class, lambda or module whose scope `node` is in. */
function scopeOf(node: SyntaxNode): SyntaxNode | null {
  for (let n = node.parent; n; n = n.parent)
    if (/^(?:FunctionDefinition|ClassDefinition|LambdaExpression|Script)$/.test(n.name)) return n;
  return null;
}

/** `name` is declared `global` / `nonlocal` in function `scope` itself, where annotating it is a SyntaxError. */
function declaredGlobal(scope: SyntaxNode, doc: Text, name: string): boolean {
  if (scope.name !== "FunctionDefinition") return false;
  let found = false;
  scope
    .getChild("Body")
    ?.cursor()
    .iterate((n) => {
      if (/^(?:FunctionDefinition|ClassDefinition|LambdaExpression)$/.test(n.name)) return false;
      if (n.name !== "ScopeStatement") return;
      const names = doc
        .sliceString(n.from, n.to)
        .replace(/^\s*(?:global|nonlocal)\s+/, "")
        .split(/\s*,\s*/);
      if (names.includes(name)) found = true;
      return false;
    });
  return found;
}

/** The Python minor version (3.x) an evaluated annotation `type` needs: 10 for `X | Y`, 9 for `list[X]`. */
export function minorNeeded(type: string): number {
  if (type.includes("|")) return 10;
  return /\b(?:list|dict|set|frozenset|tuple|type)\[/.test(type) ? 9 : 0;
}

/** The lowest Python 3 minor version `requires-python` allows, or 0 when unknown. */
export function requiredMinor(pyproject: readonly string[]): number {
  const spec = pyproject.map((l) => /^\s*requires-python\s*=\s*["']([^"']*)["']/.exec(l)?.[1]).find(Boolean);
  const m = spec && /(?:>=|~=|==)\s*3\.(\d+)/.exec(spec);
  return m ? Number(m[1]) : 0;
}

/** The newest syntax the file's evaluated annotations may use (99: anything, under the future import). */
async function annotationMinor(tree: Tree, text: Text): Promise<number> {
  const top = tree.topNode;
  const imports = [top, ...top.getChildren("StatementGroup")].flatMap((node) => node.getChildren("ImportStatement"));
  for (const statement of imports) {
    const from = statement.firstChild;
    const module = from?.nextSibling;
    if (
      from?.name !== "from" ||
      module?.name !== "VariableName" ||
      module.nextSibling?.name !== "import" ||
      text.sliceString(module.from, module.to) !== "__future__"
    )
      continue;
    const features = statement.getChildren("VariableName").slice(1);
    const annotations = features.some(
      (name) => name.prevSibling?.name !== "as" && text.sliceString(name.from, name.to) === "annotations",
    );
    if (annotations) return 99;
  }
  const root = useProject.getState().project?.root;
  const lines = root ? await readFileLines(`${root}/pyproject.toml`).catch(() => null) : null;
  return lines ? requiredMinor(lines) : 0;
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
      h.kind === "type" && h.textEdits?.length && h.label.startsWith(prefix) && posToOffset(doc, h.position) === offset,
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
  const tree = syntaxTree(state);
  const target = annotationTarget(tree, state.doc, selection.head);
  if (!target) return [];
  await whenSynced(view);
  const line = state.doc.lineAt(selection.head);
  const span = target.kind === "function" ? target.header : { from: line.from, to: line.to };
  const hints = await lspRequest(() =>
    commands.lspInlayHints(doc.doc, offsetsToRange(state.doc, span.from, span.to)),
  ).catch(() => [] as InlayHint[]);
  const evaluated = target.kind === "function" || target.evaluated;
  const minor = evaluated ? await annotationMinor(tree, state.doc) : 99;
  if (signal.aborted || view.state.doc !== state.doc) return [];
  const usable = (a: Annotation | null): Annotation | null => (a && minorNeeded(a.label) <= minor ? a : null);
  const fromHint = (h: InlayHint | undefined): Annotation | null =>
    h ? { label: h.label.trim(), edits: h.textEdits } : null;

  if (target.kind === "variable") {
    const found = usable(
      fromHint(hintAt(state.doc, hints, target.slot.end, ":")) ??
        (await hoverAnnotation(view, target.slot).catch(() => null)),
    );
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

  const returns = target.returns && usable(fromHint(hintAt(state.doc, hints, target.returns.end, "->")));
  const params = (
    await Promise.all(target.params.map((p) => hoverAnnotation(view, p).then(usable, () => null)))
  ).filter((a): a is Annotation => !!a);
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
