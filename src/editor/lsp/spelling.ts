/**
 * Proofreading › Typo: misspelt words of comments, strings and declared names
 * (the backend extracts and checks them off the UI thread), reported as
 * diagnostics of the `spelling` producer at the Typo level. Quick fixes:
 * "Change to…" (comments, literals, text: the word in place) or "Rename to…"
 * (a declared name: through Rename, so references follow), "Save 'word' to
 * project / application dictionary", and the inspection's options (→).
 */
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { whenSynced } from "@/editor/api";
import { call, commands, isCancelled, isTauri, nextRequestId, type RequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  inspectionOption,
  inspectionProfile,
  SPELLING_INSPECTION,
  SPELLING_OPTIONS,
  SPELLING_PRODUCER,
} from "@/platform/inspections";
import { intentionControls } from "@/platform/inspectionControls";
import type { Settings, SpellScope, TypoContext } from "@/bindings";
import type { MenuItem } from "@/ui";
import { setFileDiagnostics } from "./diagnostics";
import { docOf } from "./lsp";
import { rangeToOffsets } from "./positions";
import { showHint } from "./hint";
import { caretAnchor, openPopup, type ListPopupItem } from "./popupStore";
import { renameNamePart } from "./rename";

const CHECK_DELAY = 800;

interface PlacedTypo {
  from: number;
  to: number;
  word: string;
  context: TypoContext;
}

const setTypos = StateEffect.define<readonly PlacedTypo[]>();

/** The last check's typos, mapped through later edits (for the quick fixes). */
const typosField = StateField.define<readonly PlacedTypo[]>({
  create: () => [],
  update(typos, tr) {
    for (const e of tr.effects) if (e.is(setTypos)) return e.value;
    if (!tr.docChanged || !typos.length) return typos;
    return typos
      .map((t) => ({ ...t, from: tr.changes.mapPos(t.from, 1), to: tr.changes.mapPos(t.to, -1) }))
      .filter((t) => t.to > t.from);
  },
});

const spellingEnabled = () => inspectionProfile()[SPELLING_INSPECTION]?.enabled !== false;

/** What the Typo inspection's options (profile in effect) have checked. */
export function spellScope(): SpellScope {
  const profile = inspectionProfile();
  const on = (key: string) => inspectionOption(profile, SPELLING_INSPECTION, key);
  return { code: on(SPELLING_OPTIONS.code), literals: on(SPELLING_OPTIONS.literals), comments: on(SPELLING_OPTIONS.comments) };
}

const spellingOf = (s: Settings | null) => s?.spelling;

/** Lowercased words of the project and application dictionaries. */
function dictionaryWords(level: "project" | "ide"): string[] {
  const sp = spellingOf(useProject.getState().settings);
  return [...((level === "project" ? sp?.projectWords : sp?.ideWords) ?? [])];
}

export async function saveToDictionary(word: string, level: "project" | "ide") {
  const w = word.toLowerCase();
  const list = dictionaryWords(level);
  if (list.includes(w)) return;
  const key = level === "project" ? "spelling.projectWords" : "spelling.ideWords";
  const scope = level === "project" ? "project" : "global";
  const settings = await call(commands.settingsSet(scope, key, JSON.stringify([...list, w].sort())));
  useProject.setState({ settings });
}

function typoAt(state: EditorState, pos: number): PlacedTypo | undefined {
  return state
    .field(typosField, false)
    ?.find((t) => t.from <= pos && pos <= t.to && state.sliceDoc(t.from, t.to) === t.word);
}

function replaceWord(view: EditorView, typo: PlacedTypo, replacement: string) {
  if (view.state.sliceDoc(typo.from, typo.to) !== typo.word) return;
  view.dispatch({
    changes: { from: typo.from, to: typo.to, insert: replacement },
    selection: { anchor: typo.from + replacement.length },
    userEvent: "input.spelling",
  });
}

/**
 * The correction: a declared name is renamed with its references (IDEA's
 * "Typo: Rename to"); words of comments, literals and text change in place.
 */
export function applyCorrection(view: EditorView, typo: PlacedTypo, replacement: string): void | Promise<void> {
  if (typo.context === "code") return renameNamePart(view, typo, replacement);
  replaceWord(view, typo, replacement);
}

/** Letters and digits only: what can replace one word of an identifier. */
export function isNamePart(word: string): boolean {
  return /^[\p{L}\p{N}]+$/u.test(word);
}

async function changeTo(view: EditorView, typo: PlacedTypo) {
  let suggestions: string[];
  try {
    suggestions = await call(commands.spellSuggest(typo.word));
  } catch {
    suggestions = [];
  }
  const rename = typo.context === "code";
  // A name part can only become another name part: "me sage" or "me-sage" would break the code.
  if (rename) suggestions = suggestions.filter(isNamePart);
  if (!suggestions.length) {
    showHint(view, `No suggestions for '${typo.word}'`);
    return;
  }
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, typo.from),
    title: `${rename ? "Rename" : "Change"} '${typo.word}' to`,
    items: suggestions.map((s, i) => ({ id: `${i}`, label: s, run: () => applyCorrection(view, typo, s) })),
  });
}

/** Typo quick fixes at the caret (⌥↵), or none. */
export function spellingIntentions(view: EditorView): ListPopupItem[] {
  const doc = docOf(view);
  const sel = view.state.selection.main;
  if (!doc || doc.readOnly || !sel.empty || !spellingEnabled()) return [];
  const typo = typoAt(view.state, sel.head);
  if (!typo) return [];
  const hasProject = !!useProject.getState().project;
  const saves: ListPopupItem[] = [
    ...(hasProject
      ? [
          {
            id: "spelling.saveProject",
            label: `Save '${typo.word}' to project-level dictionary`,
            icon: "bulb-fix",
            run: () => saveToDictionary(typo.word, "project"),
          },
        ]
      : []),
    {
      id: "spelling.saveIde",
      label: `Save '${typo.word}' to application-level dictionary`,
      icon: "bulb-fix",
      run: () => saveToDictionary(typo.word, "ide"),
    },
  ];
  const submenu: MenuItem[] = [
    ...saves.map((s) => ({ id: s.id, label: s.label, verbatim: true, run: () => void s.run() })),
    { kind: "separator" },
    ...intentionControls({ id: SPELLING_INSPECTION, name: "Typo" }),
  ];
  return [
    {
      id: "spelling.change",
      label: typo.context === "code" ? "Typo: Rename to…" : "Typo: Change to…",
      icon: "bulb-fix",
      emphasis: true,
      run: () => changeTo(view, typo),
      submenu,
    },
    ...saves.map((s) => ({ ...s, submenu })),
  ];
}

/** Checks the file after edits (debounced), dictionary and profile changes. */
export function spellingExtension(): Extension {
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
      setFileDiagnostics(doc.path, SPELLING_PRODUCER, []);
      if (view.state.field(typosField).length) view.dispatch({ effects: setTypos.of([]) });
    };
    const run = async () => {
      const mine = ++seq;
      cancel();
      if (!spellingEnabled()) {
        clear();
        return;
      }
      const id = nextRequestId();
      request = id;
      try {
        await whenSynced(view);
        if (mine !== seq) return;
        const typos = await call(commands.spellCheck(doc.doc, spellScope(), id));
        if (mine !== seq) return;
        const text = view.state.doc;
        setFileDiagnostics(
          doc.path,
          SPELLING_PRODUCER,
          typos.map((t) => ({
            range: t.range,
            severity: "info",
            message: `Typo: In word '${t.word}'`,
            source: "Spelling",
            code: null,
          })),
        );
        const placed = typos.map((t) => ({ ...rangeToOffsets(text, t.range), word: t.word, context: t.context }));
        view.dispatch({ effects: setTypos.of(placed) });
      } catch (e) {
        if (!isCancelled(e)) console.debug("[spelling]", e);
      } finally {
        if (request === id) request = null;
      }
    };
    const schedule = (delay = CHECK_DELAY) => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    };
    schedule(200);
    const config = (s: Settings | null) => JSON.stringify([spellingOf(s), spellingEnabled(), spellScope()]);
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
        setFileDiagnostics(doc.path, SPELLING_PRODUCER, []);
      },
    };
  });
  return [typosField, plugin];
}
