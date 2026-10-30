/**
 * Gutter ▶ icons next to runnable declarations (`fn main`, tests, test suites)
 * with a Run / Debug popup, as in IntelliJ (no code lenses).
 * Targets are detected with cheap per-line regexes, recomputed (debounced) after
 * edits and mapped through changes in between.
 */
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { useProject } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { shortcutLabel } from "@/platform/keymap";
import { gutterIconMarkup, showContextMenu, type MenuItem } from "@/ui";
import { notifications, runExecutors } from "@/workbench/contributions";
import { choiceItems, executeContext, launchProduced, modifyContext, produceResolved } from "./contextRun";
import { goModulePath, loadGoModules } from "./goModules";
import { fileTargets, OPTIMISTIC, produceContextChoices, type ContextInput } from "./producers";
import { loadConfigs, useRun } from "./store";
import { targetLanguage, type RunTarget } from "./targets";
import { onTestStatesChanged, testState, testStatesVersion, type TestState } from "./testing/states";

/** Languages with gutter run targets (C / C++ `main` included). */
const hasGutterTargets = (path: string) => !!targetLanguage(path) || /\.(c|cpp|cc|cxx)$/.test(path);
import styles from "./Run.module.css";
import { tx } from "@/platform/i18n";

interface PlacedTarget extends RunTarget {
  /** Line start offset in the current state. */
  pos: number;
}

const setTargets = StateEffect.define<PlacedTarget[]>();

function place(state: EditorState, targets: RunTarget[]): PlacedTarget[] {
  return targets.filter((t) => t.line < state.doc.lines).map((t) => ({ ...t, pos: state.doc.line(t.line + 1).from }));
}

const targetsField = StateField.define<PlacedTarget[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTargets)) return e.value;
    if (!tr.docChanged || !value.length) return value;
    const out: PlacedTarget[] = [];
    for (const t of value) {
      const pos = tr.changes.mapPos(t.pos, -1);
      const line = tr.state.doc.lineAt(pos);
      if (out.some((o) => o.pos === line.from)) continue;
      out.push({ ...t, pos: line.from, line: line.number - 1 });
    }
    return out;
  },
});

function targetInput(path: string, content: string, line: number): ContextInput {
  return {
    path,
    root: useProject.getState().project?.root ?? null,
    configs: useRun.getState().configs,
    content,
    line,
    goModule: goModulePath,
  };
}

async function launch(target: RunTarget, path: string, debug: boolean, content: string) {
  if (!useProject.getState().project?.root) return;
  if (!useRun.getState().loaded) await loadConfigs();
  const produced = await produceResolved(targetInput(path, content.slice(0, 400_000), target.line));
  if (!produced) {
    notifications().notify({
      group: "run",
      level: "info",
      title: "Nothing to run here",
      body: "No run or test configuration of the project matches this file.",
      key: "run-target",
    });
    return;
  }
  // IDEA: running a gutter target creates (or reuses) a temporary configuration and selects it.
  await launchProduced(produced, debug);
}

export function targetTitle(t: RunTarget): string {
  if (t.kind === "main") return "Run";
  if (t.kind === "suite") return "Run tests";
  return "Run test";
}

export function label(t: RunTarget): string {
  if (t.kind === "main") return t.className ? `${t.name}.main()` : "main";
  return t.name;
}

export function targetMenuItems(target: RunTarget, path: string, content: string): MenuItem[] {
  const input = targetInput(path, content.slice(0, 400_000), target.line);
  const choices = produceContextChoices(input, OPTIMISTIC);
  const p = choices[0] ?? null;
  const name = p?.name ?? label(target);
  const context = { path, line: target.line, content: content.slice(0, 400_000) };
  // Several test configurations match: one entry per configuration, as IDEA's gutter does.
  const pick = (debug: boolean): Partial<MenuItem> =>
    choices.length > 1
      ? { submenu: choiceItems(choices, debug).filter((i) => i.kind !== "header") }
      : { run: () => void launch(target, path, debug, content) };
  // Like IDEA, Debug only where a debugger can run it.
  const debuggable = !p || !!(p.debug || p.config?.debugAdapter || p.missing);
  return [
    { label: tx`Run '${name}'`, icon: "run", shortcut: shortcutLabel("run.runContext"), ...pick(false) } as MenuItem,
    ...(debuggable
      ? [
          {
            label: tx`Debug '${name}'`,
            icon: "debug",
            shortcut: shortcutLabel("run.debugContext"),
            ...pick(true),
          } as MenuItem,
        ]
      : []),
    ...runExecutors()
      .filter((e) => !!p?.config && e.supports(p.config))
      .map((e) => ({ label: e.label(name), icon: e.icon, run: () => void executeContext(e.id, context) })),
    { kind: "separator" },
    { label: "Modify Run Configuration…", icon: "edit", run: () => void modifyContext(context) },
  ];
}

function showTargetMenu(view: EditorView, target: RunTarget, path: string, at: { x: number; y: number }) {
  showContextMenu(at, targetMenuItems(target, path, view.state.doc.toString()));
}

/** Results of frameworks that root their test tree at the file (jest/vitest, pytest) also match by file. */
const fileRootedResults = (path: string) => /\.(py|[cm]?[jt]sx?)$/.test(path);

/** Last test result of a gutter target (IDEA: green / red run icons after a test run). */
export function gutterTestState(target: RunTarget, path: string): TestState | null {
  if (target.kind === "main") return null;
  return testState({ path: target.path, file: fileRootedResults(path) ? path : undefined });
}

export function markerIcon(kind: RunTarget["kind"], state: TestState | null): string {
  if (state === "failed") return "gutter-run-failed";
  if (state === "passed") return "gutter-run-passed";
  return kind === "suite" ? "gutter-run-all" : "gutter-run";
}

class RunMarker extends GutterMarker {
  constructor(
    readonly target: PlacedTarget,
    readonly path: string,
    readonly state: TestState | null = null,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof RunMarker &&
      other.target.kind === this.target.kind &&
      other.target.name === this.target.name &&
      other.path === this.path &&
      other.state === this.state
    );
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = styles.runMarker ?? "";
    el.title = `${targetTitle(this.target)} '${label(this.target)}'`;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", el.title);
    el.innerHTML = gutterIconMarkup(markerIcon(this.target.kind, this.state)) ?? "";
    return el;
  }
}

/** The gutter asks for markers on every update: rebuild only when targets or test results changed. */
const markerCache = new WeakMap<readonly PlacedTarget[], { version: number; set: RangeSet<GutterMarker> }>();

function markers(state: EditorState, path: string): RangeSet<GutterMarker> {
  const targets = state.field(targetsField);
  const version = testStatesVersion();
  const cached = markerCache.get(targets);
  if (cached?.version === version) return cached.set;
  const set = RangeSet.of(
    targets.map((t) => new RunMarker(t, path, gutterTestState(t, path)).range(t.pos)),
    true,
  );
  markerCache.set(targets, { version, set });
  return set;
}

const testStatesChanged = StateEffect.define<null>();

const DEBOUNCE = 350;

export function runGutter(ctx: EditorDocContext): Extension {
  const path = ctx.path;
  if (!useProject.getState().project?.root || isVirtualUri(path) || !hasGutterTargets(path)) return [];
  if (/\.go$/.test(path))
    void loadGoModules(useProject.getState().project?.root ?? null, useRun.getState().configs).catch(() => {});
  const detect = (text: string) =>
    fileTargets({ path, root: useProject.getState().project?.root ?? null, configs: useRun.getState().configs }, text);

  const detector = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      readonly unsubscribe: () => void;
      constructor(readonly view: EditorView) {
        this.schedule(0);
        // Redraw the markers with the new results (the gutter recomputes them on any update).
        this.unsubscribe = onTestStatesChanged(() => {
          if (view.state.field(targetsField).length) view.dispatch({ effects: testStatesChanged.of(null) });
        });
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(DEBOUNCE);
      }
      schedule(delay: number) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const view = this.view;
          const found = place(view.state, detect(view.state.doc.toString()));
          const cur = view.state.field(targetsField);
          const same =
            cur.length === found.length &&
            cur.every((t, i) => t.pos === found[i]!.pos && t.name === found[i]!.name && t.kind === found[i]!.kind);
          if (!same) view.dispatch({ effects: setTargets.of(found) });
        }, delay);
      }
      destroy() {
        clearTimeout(this.timer);
        this.unsubscribe();
      }
    },
  );

  return [
    targetsField,
    detector,
    gutter({
      class: `${styles.runGutter} cm-openidea-gutter-run`,
      markers: (view) => markers(view.state, path),
      initialSpacer: () => new RunMarker({ line: 0, pos: 0, kind: "test", name: "", path: [] }, path),
      domEventHandlers: {
        mousedown: (view, block, event) => {
          const target = view.state.field(targetsField).find((t) => t.pos === block.from);
          if (!target || (event as MouseEvent).button !== 0) return false;
          const el = (event.target as HTMLElement).closest?.(`.${styles.runMarker}`) as HTMLElement | null;
          const rect = (el ?? (event.target as HTMLElement)).getBoundingClientRect();
          event.preventDefault();
          showTargetMenu(view, target, path, { x: rect.left, y: rect.bottom + 2 });
          return true;
        },
      },
    }),
  ];
}
