/**
 * Proofreading › Grammar: Harper's English grammar rules over comments,
 * docstrings, Markdown and plain text (the backend checks off the UI thread,
 * in process), reported as diagnostics of the `grammar` producer. Quick fixes:
 * Harper's suggested edits, "Disable grammar rule", and "Save to dictionary"
 * for a flagged word Harper does not know.
 */
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { whenSynced } from "@/editor/api";
import { call, commands, isCancelled, isTauri, nextRequestId, type RequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { GRAMMAR_INSPECTION, GRAMMAR_PRODUCER, inspectionProfile } from "@/platform/inspections";
import { intentionControls } from "@/platform/inspectionControls";
import type { GrammarFix, GrammarProblem, Settings } from "@/bindings";
import { setFileDiagnostics } from "./diagnostics";
import { docOf } from "./lsp";
import { rangeToOffsets } from "./positions";
import type { ListPopupItem } from "./popupStore";
import { saveToDictionary } from "./spelling";
import { tx } from "@/platform/i18n";

const CHECK_DELAY = 1000;

interface PlacedFix {
  from: number;
  to: number;
  text: string;
}

interface PlacedProblem {
  from: number;
  to: number;
  text: string;
  rule: string;
  message: string;
  fixes: PlacedFix[];
  unknownWord: boolean;
}

const setProblems = StateEffect.define<readonly PlacedProblem[]>();

/** The last check's problems, mapped through later edits (for the quick fixes). */
const problemsField = StateField.define<readonly PlacedProblem[]>({
  create: () => [],
  update(problems, tr) {
    for (const e of tr.effects) if (e.is(setProblems)) return e.value;
    if (!tr.docChanged || !problems.length) return problems;
    const map = <T extends { from: number; to: number }>(r: T): T => ({
      ...r,
      from: tr.changes.mapPos(r.from, 1),
      to: tr.changes.mapPos(r.to, -1),
    });
    return problems.map((p) => ({ ...map(p), fixes: p.fixes.map(map) })).filter((p) => p.to > p.from);
  },
});

const grammarEnabled = () => inspectionProfile()[GRAMMAR_INSPECTION]?.enabled !== false;

/** What a quick fix does, as its row reads. */
export function fixLabel(problem: Pick<GrammarProblem, "text">, fix: Pick<GrammarFix, "text"> & { empty: boolean }) {
  const name = problem.text;
  if (!fix.text) return tx`Remove '${name}'`;
  if (fix.empty) return tx`Insert '${fix.text}'`;
  return tx`Replace with '${fix.text}'`;
}

/** Letters only (and inner apostrophes or hyphens): what a dictionary can list. */
export function isWord(text: string): boolean {
  return /^\p{L}+(?:['’-]\p{L}+)*$/u.test(text);
}

/** Adds `rule` to the rules Grammar skips (application settings). */
export async function disableGrammarRule(rule: string) {
  const current = useProject.getState().settings?.grammar?.disabledRules ?? [];
  if (current.includes(rule)) return;
  const settings = await call(
    commands.settingsSet("global", "grammar.disabledRules", JSON.stringify([...current, rule].sort())),
  );
  useProject.setState({ settings });
}

function problemAt(state: EditorState, pos: number): PlacedProblem | undefined {
  return state
    .field(problemsField, false)
    ?.find((p) => p.from <= pos && pos <= p.to && state.sliceDoc(p.from, p.to) === p.text);
}

/** Grammar quick fixes at the caret (⌥↵), or none. */
export function grammarIntentions(view: EditorView): ListPopupItem[] {
  const doc = docOf(view);
  const sel = view.state.selection.main;
  if (!doc || !sel.empty || !grammarEnabled()) return [];
  const problem = problemAt(view.state, sel.head);
  if (!problem) return [];
  const hasProject = !!useProject.getState().project;
  const word = problem.text;
  const more = intentionControls({ id: GRAMMAR_INSPECTION, name: "Grammar" });
  const fixes: ListPopupItem[] = doc.readOnly
    ? []
    : problem.fixes.map((f, i) => ({
        id: `grammar.fix.${i}`,
        label: fixLabel(problem, { text: f.text, empty: f.from === f.to }),
        icon: "bulb-fix",
        emphasis: i === 0,
        run: () => {
          if (view.state.sliceDoc(problem.from, problem.to) !== problem.text) return;
          view.dispatch({
            changes: { from: f.from, to: f.to, insert: f.text },
            selection: { anchor: f.from + f.text.length },
            userEvent: "input.grammar",
          });
        },
        submenu: more,
      }));
  return [
    ...fixes,
    {
      id: "grammar.disableRule",
      label: tx`Disable grammar rule '${problem.rule}'`,
      icon: "bulb-fix",
      run: () => void disableGrammarRule(problem.rule),
      submenu: more,
    },
    ...(problem.unknownWord && isWord(word)
      ? [
          {
            id: "grammar.addWord",
            label: tx`Save '${word}' to dictionary`,
            icon: "bulb-fix" as const,
            run: () => void saveToDictionary(word, hasProject ? "project" : "ide"),
            submenu: more,
          },
        ]
      : []),
  ];
}

/** Checks the file after edits (debounced), settings and profile changes. */
export function grammarExtension(): Extension {
  const plugin = ViewPlugin.define((view: EditorView) => {
    const doc = docOf(view);
    if (!doc || doc.virtual || !isTauri()) return {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: RequestId | null = null;
    let seq = 0;
    const cancel = () => {
      if (request !== null) void commands.cancelRequest(request);
      request = null;
    };
    const clear = () => {
      setFileDiagnostics(doc.path, GRAMMAR_PRODUCER, []);
      if (view.state.field(problemsField).length) view.dispatch({ effects: setProblems.of([]) });
    };
    const run = async () => {
      const mine = ++seq;
      cancel();
      if (!grammarEnabled()) {
        clear();
        return;
      }
      const id = nextRequestId();
      request = id;
      try {
        await whenSynced(view);
        if (mine !== seq) return;
        const problems = await call(commands.grammarCheck(doc.doc, id));
        if (mine !== seq) return;
        const text = view.state.doc;
        setFileDiagnostics(
          doc.path,
          GRAMMAR_PRODUCER,
          problems.map((p) => ({
            range: p.range,
            severity: "info",
            message: p.message,
            source: "Grammar",
            code: p.rule,
          })),
        );
        const placed = problems.map((p) => ({
          ...rangeToOffsets(text, p.range),
          text: p.text,
          rule: p.rule,
          message: p.message,
          fixes: p.fixes.map((f) => ({ ...rangeToOffsets(text, f.range), text: f.text })),
          unknownWord: p.unknownWord,
        }));
        view.dispatch({ effects: setProblems.of(placed) });
      } catch (e) {
        if (!isCancelled(e)) console.debug("[grammar]", e);
      } finally {
        if (request === id) request = null;
      }
    };
    const schedule = (delay = CHECK_DELAY) => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    };
    schedule(400);
    const config = (s: Settings | null) =>
      JSON.stringify([s?.grammar, s?.spelling?.ideWords, s?.spelling?.projectWords, grammarEnabled()]);
    let lastConfig = config(useProject.getState().settings);
    const offSettings = useProject.subscribe((s, prev) => {
      if (s.settings === prev.settings && s.project === prev.project) return;
      const next = config(s.settings);
      if (next === lastConfig) return;
      lastConfig = next;
      schedule(0);
    });
    return {
      update: (u) => {
        if (u.docChanged) schedule();
      },
      destroy: () => {
        clearTimeout(timer);
        offSettings();
        seq++;
        cancel();
        setFileDiagnostics(doc.path, GRAMMAR_PRODUCER, []);
      },
    };
  });
  return [problemsField, plugin];
}
