/**
 * Python inheritance inspections: circular inheritance, `@override` consistency, abstract
 * methods a class leaves unimplemented, and overrides that only forward to the base.
 *
 * The rules read the IDE's inheritance graph (`inheritanceGraph.ts`) plus the facts the
 * Python parser reports for a document (`docPythonFacts`). Nothing here parses source text,
 * and a rule stays silent whenever the graph cannot decide: a base the project does not
 * contain (`dict`, a library class) may declare or implement anything, and a missing
 * warning is cheaper than a wrong one.
 */
import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { onServerSettled } from "@/editor/lsp/availability";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { withDocument } from "@/editor/lsp/files";
import { lspRequest } from "@/editor/lsp/lsp";
import {
  ancestryResolution,
  declarationKey,
  forgetInheritanceGraph,
  projectPythonIndex,
  type AncestryResolution,
  type InheritanceIndex,
} from "@/editor/navigation/inheritanceGraph";
import { tx } from "@/platform/i18n";
import {
  PYTHON_ABSTRACT_METHOD_INSPECTION,
  PYTHON_ABSTRACT_METHOD_PRODUCER,
  PYTHON_CIRCULAR_BASES_INSPECTION,
  PYTHON_CIRCULAR_BASES_PRODUCER,
  PYTHON_OVERRIDE_INSPECTION,
  PYTHON_OVERRIDE_PRODUCER,
  PYTHON_REDUNDANT_OVERRIDE_INSPECTION,
  PYTHON_REDUNDANT_OVERRIDE_PRODUCER,
  applyProfile,
  enabledByDefault,
  inspectionProfile,
  producerInspectionId,
} from "@/platform/inspections";
import {
  commands,
  isCancelled,
  isTauri,
  onIdeEvent,
  type ClassInheritance,
  type Diagnostic,
  type OutlineItem,
  type PythonClassFacts,
  type PythonFacts,
  type PythonMethodFacts,
  type Range,
} from "@/platform/ipc";

/** The inspection producers, one per rule. */
const PRODUCERS = [
  PYTHON_CIRCULAR_BASES_PRODUCER,
  PYTHON_OVERRIDE_PRODUCER,
  PYTHON_ABSTRACT_METHOD_PRODUCER,
  PYTHON_REDUNDANT_OVERRIDE_PRODUCER,
];

/** What the rules read for one document: its own facts and a way to read another file's. */
export interface InheritanceInspectionDeps {
  path: string;
  outline: readonly OutlineItem[];
  facts: PythonFacts;
  index: InheritanceIndex;
  factsOf: (path: string) => Promise<PythonFacts | null>;
  outlineOf: (path: string) => Promise<readonly OutlineItem[]>;
  /** Producers whose inspection is on; missing means every rule runs. */
  enabled?: ReadonlySet<string>;
}

const isDunder = (name: string) => name.startsWith("__") && name.endsWith("__");
const baseName = (name: string) => name.replace(/\s*[(<].*$/, "");
const sameNames = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((name, i) => name === b[i]);

/** One class of the document: its graph declaration, its facts and its members. */
interface ClassView {
  decl: ClassInheritance;
  facts: PythonClassFacts;
  /** Names the class itself declares: methods, fields, properties, nested types. */
  members: ReadonlySet<string>;
  /** How deep the ancestry stays inside the project (`Infinity`: all of it). */
  firstUnresolvedDepth: number;
}

/** Everything the rules need for one document, with every project read memoised. */
class ProjectView {
  private facts = new Map<string, Promise<PythonFacts | null>>();
  private outlines = new Map<string, Promise<readonly OutlineItem[]>>();
  private ancestry = new Map<string, Promise<AncestryResolution>>();

  constructor(private readonly deps: InheritanceInspectionDeps) {}

  /** The document's classes, in declaration order, skipping ones the graph does not match. */
  async classes(): Promise<ClassView[]> {
    const out: ClassView[] = [];
    for (const facts of this.deps.facts.classes) {
      const decl = this.declarationOf(facts);
      if (!decl) continue;
      const item = classItem(this.deps.outline, facts);
      const { firstUnresolvedDepth } = await this.ancestryOf(decl);
      out.push({ decl, facts, members: memberNames(item), firstUnresolvedDepth });
    }
    return out;
  }

  /** The ancestors of `cls`, with the depth each sits at. */
  ancestors(cls: ClassView): Promise<AncestryResolution["ancestors"]> {
    return this.ancestryOf(cls.decl).then((r) => r.ancestors);
  }

  /** Whether the whole chain resolved inside the project. */
  complete(cls: ClassView): boolean {
    return cls.firstUnresolvedDepth === Infinity;
  }

  /** Whether the chain is trustworthy at `depth`: no foreign base sits above it. */
  knownTo(cls: ClassView, depth: number): boolean {
    return cls.firstUnresolvedDepth > depth;
  }

  async methodsOf(decl: ClassInheritance): Promise<PythonMethodFacts[]> {
    const facts = await this.factsOf(decl.path);
    return facts?.classes.find((c) => sameDeclaration(c, decl))?.methods ?? [];
  }

  async membersOf(decl: ClassInheritance): Promise<ReadonlySet<string>> {
    const outline = await this.outlineOf(decl.path);
    const item = outline.find(
      (i) =>
        i.kind === "class" && i.selection_range.start.line === decl.line && i.selection_range.start.col === decl.col,
    );
    return memberNames(item ?? null);
  }

  private declarationOf(facts: PythonClassFacts): ClassInheritance | null {
    const found = this.deps.index.byName.get(facts.name) ?? [];
    return (
      found.find(
        (c) =>
          c.path === this.deps.path && c.line === facts.selection.start.line && c.col === facts.selection.start.col,
      ) ?? null
    );
  }

  private factsOf(path: string): Promise<PythonFacts | null> {
    return memo(this.facts, path, () => this.deps.factsOf(path));
  }

  private outlineOf(path: string): Promise<readonly OutlineItem[]> {
    return memo(this.outlines, path, () => this.deps.outlineOf(path));
  }

  private ancestryOf(decl: ClassInheritance): Promise<AncestryResolution> {
    return memo(this.ancestry, declarationKey(decl), () => ancestryResolution(this.deps.index, decl));
  }
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let pending = cache.get(key);
  if (!pending) {
    pending = read();
    cache.set(key, pending);
  }
  return pending;
}

/** The names a class declares: methods, fields, properties, nested types. */
function memberNames(item: OutlineItem | null): ReadonlySet<string> {
  return new Set((item?.children ?? []).map((child) => baseName(child.name)));
}

function classItem(outline: readonly OutlineItem[], cls: PythonClassFacts): OutlineItem | null {
  const find = (items: readonly OutlineItem[]): OutlineItem | null => {
    for (const item of items) {
      if (
        item.kind === "class" &&
        item.selection_range.start.line === cls.selection.start.line &&
        item.selection_range.start.col === cls.selection.start.col
      ) {
        return item;
      }
      const deeper = find(item.children);
      if (deeper) return deeper;
    }
    return null;
  };
  return find(outline);
}

function sameDeclaration(cls: PythonClassFacts, decl: ClassInheritance): boolean {
  return cls.selection.start.line === decl.line && cls.selection.start.col === decl.col;
}

/** Everything the four rules produce for one document. */
export async function inheritanceDiagnostics(deps: InheritanceInspectionDeps): Promise<Diagnostic[]> {
  const view = new ProjectView(deps);
  const runs = (producer: string) => deps.enabled?.has(producer) ?? true;
  const out: Diagnostic[] = [];
  for (const cls of await view.classes()) {
    // A class whose header changed since the graph was indexed is skipped: every rule
    // below would reason about a parent the source no longer names.
    if (!sameNames(cls.facts.bases, cls.decl.bases)) continue;
    if (runs(PYTHON_CIRCULAR_BASES_PRODUCER)) out.push(...(await circularInheritance(view, cls)));
    // A method may live on any ancestor: only a fully known chain can say it does not.
    if (runs(PYTHON_OVERRIDE_PRODUCER) && view.complete(cls)) out.push(...(await unusedOverride(view, cls)));
    if (runs(PYTHON_REDUNDANT_OVERRIDE_PRODUCER)) out.push(...(await redundantOverride(view, cls)));
    if (runs(PYTHON_ABSTRACT_METHOD_PRODUCER)) out.push(...(await missingAbstractMethods(view, cls)));
  }
  return out;
}

/** A class that (transitively) inherits from itself: Python raises at import time. */
async function circularInheritance(view: ProjectView, cls: ClassView): Promise<Diagnostic[]> {
  const ancestors = await view.ancestors(cls);
  if (!ancestors.some((a) => declarationKey(a.decl) === declarationKey(cls.decl))) return [];
  return [
    problem(
      cls.facts.selection,
      PYTHON_CIRCULAR_BASES_INSPECTION,
      "error",
      tx`Circular inheritance: '${cls.facts.name}' inherits from itself`,
    ),
  ];
}

/** `@override` on a method no ancestor declares: a typo, or a base that changed name. */
async function unusedOverride(view: ProjectView, cls: ClassView): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  for (const method of cls.facts.methods) {
    if (!method.overrideDecorated || isDunder(method.name)) continue;
    if (await declaredInAncestry(view, cls, method.name)) continue;
    out.push(
      problem(
        method.selection,
        PYTHON_OVERRIDE_INSPECTION,
        "warning",
        tx`Method '${method.name}' is marked @override but no base class declares it`,
      ),
    );
  }
  return out;
}

/** Abstract methods of the ancestry that no class on the way down implements. */
async function missingAbstractMethods(view: ProjectView, cls: ClassView): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  const reported = new Set<string>();
  for (const ancestor of await view.ancestors(cls)) {
    // A foreign base above the declarer cannot override it: Python's MRO puts it later.
    if (!view.knownTo(cls, ancestor.depth - 1)) continue;
    for (const method of await view.methodsOf(ancestor.decl)) {
      const name = method.name;
      if (!method.abstractMethod || reported.has(name) || cls.members.has(name)) continue;
      if (await implementedAbove(view, cls, ancestor.depth, name)) continue;
      reported.add(name);
      out.push(
        problem(
          cls.facts.selection,
          PYTHON_ABSTRACT_METHOD_INSPECTION,
          "warning",
          tx`Class '${cls.facts.name}' does not implement abstract method '${name}'`,
        ),
      );
    }
  }
  return out;
}

/** Whether an ancestor nearer than `declarer` implements `name` concretely. */
async function implementedAbove(
  view: ProjectView,
  cls: ClassView,
  declarerDepth: number,
  name: string,
): Promise<boolean> {
  for (const ancestor of await view.ancestors(cls)) {
    if (ancestor.depth >= declarerDepth) return false;
    if (!view.knownTo(cls, ancestor.depth - 1)) return true;
    const method = (await view.methodsOf(ancestor.decl)).find((m) => m.name === name);
    if (method) return !method.abstractMethod;
    if ((await view.membersOf(ancestor.decl)).has(name)) return true;
  }
  return false;
}

/** A method whose body the inherited method already provides. */
async function redundantOverride(view: ProjectView, cls: ClassView): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  for (const method of cls.facts.methods) {
    const inherited = await inheritedMethod(view, cls, method.name);
    // A foreign base below the declarer cannot change which method runs: MRO puts it later.
    if (!inherited || !view.knownTo(cls, inherited.depth)) continue;
    if (inherited.method.abstractMethod || !redundantBody(method, inherited.method)) continue;
    out.push(
      problem(
        method.selection,
        PYTHON_REDUNDANT_OVERRIDE_INSPECTION,
        "info",
        tx`Redundant override of '${method.name}'`,
      ),
    );
  }
  return out;
}

/**
 * Whether deleting `override` keeps what it does: it is a no-op over a no-op, or it forwards
 * exactly its own parameters to the inherited method (a bare call only when the inherited
 * method returns nothing, so discarding its value changes nothing).
 */
function redundantBody(override: PythonMethodFacts, base: PythonMethodFacts): boolean {
  if (override.body.kind === "empty") return base.body.kind === "empty";
  if (override.body.kind !== "superCall") return false;
  if (override.body.target !== override.name) return false;
  if (!override.params || !base.params) return false;
  if (!sameNames(base.params, override.params)) return false;
  // `super().m()` forwards every parameter but the receiver.
  if (!sameNames(override.body.args, override.params.slice(1))) return false;
  return override.body.returns || base.body.kind === "empty";
}

/** The nearest ancestor's method `name`. */
async function inheritedMethod(
  view: ProjectView,
  cls: ClassView,
  name: string,
): Promise<{ method: PythonMethodFacts; depth: number } | null> {
  for (const ancestor of await view.ancestors(cls)) {
    const found = (await view.methodsOf(ancestor.decl)).find((m) => m.name === name);
    if (found) return { method: found, depth: ancestor.depth };
  }
  return null;
}

/** Whether any ancestor declares `name`, as a member or a method. */
async function declaredInAncestry(view: ProjectView, cls: ClassView, name: string): Promise<boolean> {
  for (const ancestor of await view.ancestors(cls)) {
    if ((await view.membersOf(ancestor.decl)).has(name)) return true;
    if ((await view.methodsOf(ancestor.decl)).some((m) => m.name === name)) return true;
  }
  return false;
}

const problem = (range: Range, producer: string, severity: Diagnostic["severity"], message: string): Diagnostic => ({
  range,
  severity,
  message,
  source: "Python",
  code: producer,
});

// --- the editor plugin -------------------------------------------------------

const DEBOUNCE_MS = 500;
const SOURCE = "Python";
const refreshables = new Set<() => void>();
let watching = false;

/** Python files are the ones that change this inheritance graph. */
const isPythonFile = (path: string) => path.endsWith(".py") || path.endsWith(".pyi");

/** One subscription per window: the graph's inputs changed, so re-run every open document. */
function watchChanges() {
  if (watching) return;
  watching = true;
  const refreshAll = () => {
    forgetInheritanceGraph();
    for (const refresh of refreshables) refresh();
  };
  onIdeEvent("fsChanged", (e) => {
    if ([...e.created, ...e.modified, ...e.removed].some(isPythonFile)) refreshAll();
  });
  onServerSettled(refreshAll);
}

/** The producers whose inspection is on in the profile in effect. */
function enabledProducers(): Set<string> {
  const profile = inspectionProfile();
  return new Set(
    PRODUCERS.filter((producer) => {
      const id = producerInspectionId(producer);
      return profile[id]?.enabled ?? enabledByDefault(id);
    }),
  );
}

/** The inspection id -> producer, for applying the profile to what the rules produced. */
const PRODUCER_OF = new Map(PRODUCERS.map((producer) => [producerInspectionId(producer), producer]));

/** Applies the profile in effect to `diagnostics` (their `code` is the inspection id). */
function applyProfileTo(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const profile = inspectionProfile();
  const grouped = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const id = diagnostic.code ?? "";
    grouped.set(id, [...(grouped.get(id) ?? []), diagnostic]);
  }
  return [...grouped].flatMap(([id, items]) => [
    ...(applyProfile(profile, PRODUCER_OF.get(id) ?? id, items) as readonly Diagnostic[]),
  ]);
}

const viewers = new Map<string, number>();
const hasClass = (items: readonly OutlineItem[]): boolean =>
  items.some((item) => item.kind === "class" || hasClass(item.children));

/** Runs the inspections on Python documents and publishes them as local diagnostics. */
export function pythonInheritanceExtension(ctx: EditorDocContext): Extension {
  if (ctx.language !== "python" || ctx.virtual || ctx.doc < 0) return [];
  watchChanges();
  return ViewPlugin.define((view: EditorView) => {
    if (!isTauri()) return {};
    viewers.set(ctx.path, (viewers.get(ctx.path) ?? 0) + 1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sequence = 0;
    let disposed = false;

    const run = async () => {
      const enabled = enabledProducers();
      if (!enabled.size) {
        setFileDiagnostics(ctx.path, SOURCE, []);
        return;
      }
      const mine = ++sequence;
      const text = view.state.doc;
      try {
        const outline = await lspRequest(() => commands.docOutline(ctx.doc));
        // Every rule is about a class: no class, nothing to fetch the graph for.
        if (!hasClass(outline)) {
          setFileDiagnostics(ctx.path, SOURCE, []);
          return;
        }
        const [facts, project] = await Promise.all([
          lspRequest(() => commands.docPythonFacts(ctx.doc)),
          projectPythonIndex(),
        ]);
        const found = await inheritanceDiagnostics({
          path: ctx.path,
          outline,
          facts,
          index: project.index,
          enabled,
          factsOf: (path) =>
            withDocument(path, (doc) => lspRequest(() => commands.docPythonFacts(doc))).catch(() => null),
          outlineOf: (path) => withDocument(path, (doc) => lspRequest(() => commands.docOutline(doc))).catch(() => []),
        });
        if (disposed || mine !== sequence || view.state.doc !== text) return;
        // The profile decides what is shown and how strongly.
        setFileDiagnostics(ctx.path, SOURCE, applyProfileTo(found));
      } catch (e) {
        if (!isCancelled(e)) console.debug("[inheritanceInspections]", e);
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      sequence++;
      timer = setTimeout(() => void run(), DEBOUNCE_MS);
    };
    const refresh = () => schedule();
    refreshables.add(refresh);
    schedule();

    return {
      update: (update) => {
        if (update.docChanged) schedule();
      },
      destroy: () => {
        disposed = true;
        clearTimeout(timer);
        refreshables.delete(refresh);
        const left = (viewers.get(ctx.path) ?? 1) - 1;
        if (left > 0) {
          viewers.set(ctx.path, left);
          return;
        }
        viewers.delete(ctx.path);
        setFileDiagnostics(ctx.path, SOURCE, []);
      },
    };
  });
}
