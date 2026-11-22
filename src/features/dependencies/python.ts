/**
 * Requirements of `requirements*.txt` / `pyproject.toml` that the project's interpreter doesn't
 * satisfy (PyCharm's "Package requirements are not satisfied"): a warning on each, quick fixes
 * and a banner that install them with pip / uv as Settings › Python Interpreter does.
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
import { call, commands, nextRequestId, onIdeEvent, type PythonRequirements, type RequestId } from "@/platform/ipc";
import { PYTHON_REQUIREMENTS_INSPECTION, PYTHON_REQUIREMENTS_PRODUCER } from "@/platform/inspections";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { notifications, registerEditorBanner } from "@/workbench/contributions";
import { upsertTask } from "@/workbench/tasks";
import { checkEnabled, manifestCheck, type ManifestCheck } from "./manifestCheck";

interface State {
  /** By file: its last check, when something was unsatisfied. */
  byPath: Map<string, PythonRequirements>;
  /** Interpreters an install is running for. */
  installing: Set<string>;
  /** Banner dismissed until the project is reopened. */
  ignored: boolean;
  /** Bumped when an install ends: open manifests check again. */
  installs: number;
}

const initial = (): State => ({ byPath: new Map(), installing: new Set(), ignored: false, installs: 0 });
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

function setInstalling(python: string, on: boolean) {
  useRequirements.setState((s) => {
    const installing = new Set(s.installing);
    if (on) installing.add(python);
    else installing.delete(python);
    return on ? { installing } : { installing, installs: s.installs + 1 };
  });
}

/** Installs `requirements` one by one into `python`, as a background task; failures end in one notification. */
export async function installRequirements(python: string, requirements: readonly string[]): Promise<void> {
  if (!requirements.length || useRequirements.getState().installing.has(python)) return;
  setInstalling(python, true);
  const id = `python-requirements:${python}`;
  const title = tx("Installing package requirements");
  let current: RequestId | null = null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    if (current !== null) void commands.cancelRequest(current);
  };
  const failures: string[] = [];
  try {
    for (const [i, requirement] of requirements.entries()) {
      if (cancelled) break;
      const progress = (message: string) =>
        upsertTask({ id, title, message, fraction: i / requirements.length, done: false, cancel });
      progress(requirement);
      const channel = new Channel<string>();
      channel.onmessage = (line) => line.trim() && progress(line.trim());
      current = nextRequestId();
      try {
        await call(commands.sdkPythonPip(python, requirement, false, false, current, channel));
      } catch (e) {
        if (!cancelled) failures.push(`${requirement}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    upsertTask({ id, title, message: null, fraction: 1, done: true });
    setInstalling(python, false);
  }
  if (failures.length)
    notifications().notify({
      level: "error",
      title: "Cannot install package requirements",
      body: failures.join("\n"),
    });
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
  const { python, unsatisfied } = found;
  const at = unsatisfied.filter(({ dependency }) => from <= dependency.to && to >= dependency.from);
  if (!at.length) return [];
  const fixes: ContributedIntention[] = at.map(({ dependency }) => ({
    id: `python.installRequirement:${dependency.from}`,
    label: tx("Install requirement"),
    quickFix: true,
    run: () => void installRequirements(python, [dependency.requirement]),
  }));
  if (unsatisfied.length > 1)
    fixes.push({
      id: "python.installRequirements",
      label: tx("Install all missing requirements"),
      quickFix: true,
      run: () =>
        void installRequirements(
          python,
          unsatisfied.map(({ dependency }) => dependency.requirement),
        ),
    });
  return fixes;
}

const requirementsCheck = (path: string): ManifestCheck<PythonRequirements | null> => ({
  inspection: PYTHON_REQUIREMENTS_INSPECTION,
  producer: PYTHON_REQUIREMENTS_PRODUCER,
  onFocus: true,
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
    const offSettings = useProject.subscribe((s, prev) => {
      if (s.settings !== prev.settings) recheck();
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
  return {
    text: "Package requirements are not satisfied",
    level: "warning" as const,
    actions: [
      {
        label: "Install requirements",
        run: () =>
          void installRequirements(
            found.python,
            found.unsatisfied.map((u) => u.dependency.requirement),
          ),
      },
      { label: "Ignore", run: () => useRequirements.setState({ ignored: true }) },
    ],
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
