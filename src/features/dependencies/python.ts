/**
 * Requirements of `requirements*.txt` / `pyproject.toml` that the project's interpreter doesn't
 * satisfy (PyCharm's "Package requirements are not satisfied"): a warning on each, quick fixes
 * and a banner that install them with pip / uv, the installer Settings › Python Interpreter uses.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  intentionProviders,
  intentionsChanged,
  offsetsToRange,
  quickFixProviders,
  type ContributedIntention,
  type EditorDocContext,
} from "@/editor/api";
import { call, commands, isCancelled, nextRequestId, onIdeEvent, type PythonRequirements } from "@/platform/ipc";
import { PYTHON_REQUIREMENTS_INSPECTION, PYTHON_REQUIREMENTS_PRODUCER } from "@/platform/inspections";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { notifications, registerEditorBanner } from "@/workbench/contributions";
import { queueTask, upsertTask } from "@/workbench/tasks";
import { checkEnabled, manifestCheck, type ManifestCheck } from "./manifestCheck";

interface State {
  /** By file: its last check, when something was unsatisfied. */
  byPath: Map<string, PythonRequirements>;
  /** Installs running or queued, by interpreter. */
  installing: Map<string, number>;
  /** Banner dismissed until the project is reopened. */
  ignored: boolean;
  /** Bumped when an install ends: open manifests check again. */
  installs: number;
}

const initial = (): State => ({ byPath: new Map(), installing: new Map(), ignored: false, installs: 0 });
export const useRequirements = create<State>(initial);

export const isPythonManifest = (path: string) => /(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml)$/.test(path);

function setResult(path: string, result: PythonRequirements | null) {
  useRequirements.setState((s) => {
    if (!result?.unsatisfied.length && !s.byPath.has(path)) return s;
    const byPath = new Map(s.byPath);
    if (result?.unsatisfied.length) byPath.set(path, result);
    else byPath.delete(path);
    return { byPath };
  });
}

function countInstall(python: string, delta: 1 | -1) {
  useRequirements.setState((s) => {
    const installing = new Map(s.installing);
    const count = (installing.get(python) ?? 0) + delta;
    if (count > 0) installing.set(python, count);
    else installing.delete(python);
    return delta > 0 ? { installing } : { installing, installs: s.installs + 1 };
  });
}

/** The lines that install `unsatisfied`, leaving out what the IDE can't install faithfully. */
const installLines = (unsatisfied: PythonRequirements["unsatisfied"]) =>
  unsatisfied.flatMap((u) => (u.install === null ? [] : [u.install]));

let installSeq = 0;

/**
 * Installs requirement `lines` into the checked interpreter with one `pip install -r` that also
 * carries the manifest's options (indexes, constraints, hash mode), as a background task queued
 * behind other installs into that interpreter; a failure ends in a notification.
 */
export async function installRequirements(found: PythonRequirements, lines: readonly string[]): Promise<void> {
  if (!lines.length) return;
  const { python, options } = found;
  const id = `python-requirements:${++installSeq}`;
  const title = tx("Installing package requirements");
  countInstall(python, 1);
  try {
    await queueTask(`python-requirements:${python}`, { id, title }, async () => {
      const request = nextRequestId();
      const cancel = () => void commands.cancelRequest(request);
      const progress = (message: string) => upsertTask({ id, title, message, fraction: null, done: false, cancel });
      progress(lines.join(", "));
      const channel = new Channel<string>();
      channel.onmessage = (line) => line.trim() && progress(line.trim());
      try {
        await call(commands.sdkPythonInstallRequirements(python, [...options, ...lines], request, channel));
      } finally {
        upsertTask({ id, title, message: null, fraction: 1, done: true });
      }
    });
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({
        level: "error",
        title: "Cannot install package requirements",
        body: e instanceof Error ? e.message : String(e),
      });
  } finally {
    countInstall(python, -1);
  }
}

const setFound = StateEffect.define<PythonRequirements | null>();
const foundField = StateField.define<PythonRequirements | null>({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged) return null;
    for (const effect of tr.effects) if (effect.is(setFound)) return effect.value;
    return value;
  },
});

export function requirementFixes(view: EditorView, from: number, to: number): ContributedIntention[] {
  if (!checkEnabled(PYTHON_REQUIREMENTS_INSPECTION)) return [];
  const found = view.state.field(foundField, false);
  if (!found) return [];
  const at = found.unsatisfied.filter(
    ({ dependency, install }) => install !== null && from <= dependency.to && to >= dependency.from,
  );
  if (!at.length) return [];
  const fixes: ContributedIntention[] = at.map(({ dependency, install }) => ({
    id: `python.installRequirement:${dependency.from}`,
    label: tx("Install requirement"),
    quickFix: true,
    run: () => void installRequirements(found, [install!]),
  }));
  const all = installLines(found.unsatisfied);
  if (all.length > 1)
    fixes.push({
      id: "python.installRequirements",
      label: tx("Install all missing requirements"),
      quickFix: true,
      run: () => void installRequirements(found, all),
    });
  return fixes;
}

const requirementsCheck = (path: string): ManifestCheck<PythonRequirements | null> => ({
  inspection: PYTHON_REQUIREMENTS_INSPECTION,
  producer: PYTHON_REQUIREMENTS_PRODUCER,
  // An install in a terminal shows when the editor is back in focus, at most twice a minute.
  onFocus: 30_000,
  fetch: (doc, id) => call(commands.pythonRequirements(doc.doc, id)),
  apply(view, result, text) {
    view.dispatch({ effects: [setFound.of(result), intentionsChanged.of(null)] });
    setResult(path, result);
    return (result?.unsatisfied ?? []).map(({ dependency: { package: name, requirement, from, to }, installed }) => ({
      range: offsetsToRange(text, from, to),
      severity: "warning" as const,
      message:
        installed === null
          ? tx`Package ${name} is not installed`
          : tx`Requirement ${requirement} is not satisfied: ${installed} is installed`,
      source: "Python",
      code: null,
    }));
  },
  reset: () => setResult(path, null),
  watch: (recheck) => {
    const offInstalls = useRequirements.subscribe((s, prev) => {
      if (s.installs !== prev.installs) recheck();
    });
    // Another interpreter chosen.
    const interpreter = (s: ReturnType<typeof useProject.getState>) => s.settings?.languages?.python?.interpreter;
    const offSettings = useProject.subscribe((s, prev) => {
      if (interpreter(s) !== interpreter(prev)) recheck();
    });
    // Restricted Mode never runs the interpreter: check once the project is trusted.
    const offTrust = onIdeEvent("projectTrustChanged", (e) => {
      if (e.trusted) recheck();
    });
    return () => {
      offInstalls();
      offSettings();
      offTrust();
    };
  },
});

export function pythonRequirements(doc: EditorDocContext): Extension {
  return [
    foundField,
    manifestCheck(doc, requirementsCheck(doc.path)),
    intentionProviders.of((view) => {
      const selection = view.state.selection.main;
      return requirementFixes(view, selection.from, selection.to);
    }),
    quickFixProviders.of(requirementFixes),
  ];
}

function useRequirementsBanner(path: string) {
  const found = useRequirements((s) => (s.ignored ? undefined : s.byPath.get(path)));
  const installing = useRequirements((s) => !!found && s.installing.has(found.python));
  if (!found || installing) return null;
  const lines = installLines(found.unsatisfied);
  const ignore = { label: "Ignore", run: () => useRequirements.setState({ ignored: true }) };
  return {
    text: "Package requirements are not satisfied",
    level: "warning" as const,
    actions: lines.length
      ? [{ label: "Install requirements", run: () => void installRequirements(found, lines) }, ignore]
      : [ignore],
  };
}

export function registerPythonRequirements(): () => void {
  useRequirements.setState(initial());
  const offBanner = registerEditorBanner({ id: "python.requirements", order: 10, useBanner: useRequirementsBanner });
  const offProject = useProject.subscribe((s, prev) => {
    if (s.project?.root !== prev.project?.root) useRequirements.setState(initial());
  });
  return () => {
    offBanner();
    offProject();
  };
}
