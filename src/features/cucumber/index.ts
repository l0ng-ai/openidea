/**
 * Cucumber steps: Go to Declaration (⌘-click, ⌘B) on a `.feature` step opens its JavaScript /
 * TypeScript step definitions, and on a definition's pattern lists the feature steps it
 * matches. Steps no definition matches are reported (Undefined step), with a quick fix that
 * writes a pending definition into the project's step file.
 */
import { ViewPlugin, type EditorView } from "@codemirror/view";
import {
  intentionProviders,
  intentionsChanged,
  quickFixProviders,
  registerEditorContribution,
  whenAllSynced,
  type ContributedIntention,
} from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { docOf } from "@/editor/lsp/lsp";
import { offsetsToRange } from "@/editor/lsp/positions";
import { registerNavigationProvider } from "@/editor/navigationProviders";
import type { Diagnostic } from "@/bindings";
import { tx } from "@/platform/i18n";
import { CUCUMBER_UNDEFINED_STEP_PRODUCER } from "@/platform/inspections";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { editorService, notifications } from "@/workbench/contributions";
import { definingKeyword, featureSteps, stepDefinitions, stepSnippet, type FeatureStep } from "./steps";
import {
  clearStepIndex,
  definitionFileFor,
  definitionsOf,
  isCucumberSource,
  undefinedSteps,
  usagesOf,
} from "./stepIndex";

const SCRIPT = /\.[cm]?[jt]sx?$/i;
const FEATURE = /\.feature$/i;
const DELAY_MS = 300;

/** The undefined steps each `.feature` editor shows, for its quick fixes. */
const undefinedByView = new WeakMap<EditorView, { steps: FeatureStep[]; all: FeatureStep[] }>();
/** Re-checks every open feature file (the step index changed). */
const recheckers = new Set<() => void>();

function diagnosticOf(view: EditorView, step: FeatureStep): Diagnostic {
  return {
    range: offsetsToRange(view.state.doc, step.from, step.to),
    severity: "warning",
    message: tx`Undefined step reference: ${step.text}`,
    source: "Cucumber",
    code: null,
  };
}

/** Appends a pending definition of `step` to the project's step file and shows it. */
async function createDefinition(featurePath: string, all: readonly FeatureStep[], step: FeatureStep) {
  const target = await definitionFileFor(featurePath);
  if (!target) return;
  try {
    await editorService().openFile(target);
    const cursor = editorService().activeCursor();
    const text =
      cursor?.path === target
        ? (await call(commands.docSnapshot(cursor.doc))).text
        : await call(commands.fsReadText(target));
    const lines = text.split("\n");
    const end = { line: lines.length - 1, col: lines[lines.length - 1]!.length };
    const lead = text.length === 0 ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    const style = /\bcreateBdd\s*\(/.test(text) ? "playwright-bdd" : "cucumber";
    const snippet = stepSnippet(definingKeyword(all, step), step.matchText, style);
    await whenAllSynced();
    await call(
      commands.applyWorkspaceEdit({
        files: [{ kind: "edit", path: target, edits: [{ range: { start: end, end }, new_text: lead + snippet.text }] }],
      }),
    );
    // The body line (the pending return, or the comment) is selected.
    const line = end.line + lead.split("\n").length - 1 + snippet.body;
    const body = snippet.text.split("\n")[snippet.body]!;
    await editorService().openFile(target, { selection: { line, col: 2, endLine: line, endCol: body.length } });
  } catch (e) {
    notifications().notify({
      group: "cucumber",
      level: "error",
      title: tx("Create Step Definition"),
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

function quickFixes(view: EditorView, from: number, to: number): ContributedIntention[] {
  const doc = docOf(view);
  const found = undefinedByView.get(view);
  if (!doc || !found) return [];
  return found.steps
    .filter((s) => s.from <= to && from <= s.to)
    .map((step) => ({
      id: "cucumber.createStepDefinition",
      label: tx`Create step definition '${step.text}'`,
      icon: "bulb-fix",
      quickFix: true,
      run: () => createDefinition(doc.path, found.all, step),
    }));
}

/** The Undefined step check of a `.feature` editor. */
const undefinedStepCheck = (path: string) =>
  ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    const check = async () => {
      const gen = ++generation;
      const all = featureSteps(view.state.doc.toString());
      const steps = await undefinedSteps(all).catch(() => null);
      if (gen !== generation) return;
      undefinedByView.set(view, { steps: steps ?? [], all });
      view.dispatch({ effects: intentionsChanged.of(null) });
      setFileDiagnostics(
        path,
        CUCUMBER_UNDEFINED_STEP_PRODUCER,
        (steps ?? []).map((s) => diagnosticOf(view, s)),
      );
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void check(), DELAY_MS);
    };
    recheckers.add(schedule);
    void check();
    return {
      update: (u) => {
        if (u.docChanged) schedule();
      },
      destroy: () => {
        clearTimeout(timer);
        generation++;
        recheckers.delete(schedule);
        setFileDiagnostics(path, CUCUMBER_UNDEFINED_STEP_PRODUCER, []);
      },
    };
  });

export function activate(): () => void {
  const unregister = registerNavigationProvider(async (view, offset) => {
    const doc = docOf(view);
    if (!doc || doc.virtual) return null;
    const text = view.state.doc.toString();
    if (FEATURE.test(doc.path)) {
      const step = featureSteps(text).find((s) => s.from <= offset && offset < s.to);
      if (!step) return null;
      const targets = await definitionsOf(step);
      return targets.length ? { from: step.from, to: step.to, targets } : null;
    }
    if (!SCRIPT.test(doc.path)) return null;
    const definition = stepDefinitions(text).find((d) => d.from <= offset && offset < d.to);
    if (!definition) return null;
    const targets = await usagesOf(definition);
    return targets.length ? { from: definition.from, to: definition.to, targets } : null;
  });
  const unregisterCheck = registerEditorContribution({
    id: "cucumber.undefinedSteps",
    extensions: (doc) =>
      doc.virtual || !FEATURE.test(doc.path)
        ? []
        : [
            undefinedStepCheck(doc.path),
            quickFixProviders.of(quickFixes),
            // Alt+Enter at the caret.
            intentionProviders.of((view) => {
              const head = view.state.selection.main.head;
              return quickFixes(view, head, head);
            }),
          ],
  });
  const unsubscribe = onIdeEvent("fsChanged", (e) => {
    if ([...e.created, ...e.modified, ...e.removed].some((p) => isCucumberSource(String(p)))) {
      clearStepIndex();
      for (const recheck of recheckers) recheck();
    }
  });
  return () => {
    unsubscribe();
    unregisterCheck();
    unregister();
    clearStepIndex();
  };
}
