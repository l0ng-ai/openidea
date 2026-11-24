import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import {
  intentionProviders,
  intentionsChanged,
  offsetsToRange,
  quickFixProviders,
  registerEditorContribution,
  whenSynced,
  type ContributedIntention,
  type EditorDocContext,
} from "@/editor/api";
import { call, commands, isTauri, nextRequestId, type DependencyVersions } from "@/platform/ipc";
import { DEPENDENCY_INSPECTION, DEPENDENCY_PRODUCER } from "@/platform/inspections";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { checkEnabled, manifestCheck, type ManifestCheck } from "./manifestCheck";
import { isPythonManifest, pythonRequirements, registerPythonRequirements } from "./python";

const setVersions = StateEffect.define<DependencyVersions[]>();
const versionsField = StateField.define<DependencyVersions[]>({
  create: () => [],
  update(value, tr) {
    if (tr.docChanged) return [];
    for (const effect of tr.effects) if (effect.is(setVersions)) return effect.value;
    return value;
  },
});

export function dependencyFixes(view: EditorView, from: number, to: number): ContributedIntention[] {
  if (!checkEnabled(DEPENDENCY_INSPECTION) || view.state.readOnly) return [];
  const text = view.state.doc;
  return (view.state.field(versionsField, false) ?? []).flatMap(({ dependency, update }) => {
    if (!update || from > dependency.to || to < dependency.from) return [];
    const { replacement } = update;
    return [
      {
        id: `dependency.update:${dependency.from}`,
        label: tx`Update to ${replacement}`,
        quickFix: true,
        run: () => {
          if (view.state.doc !== text) return;
          view.dispatch({
            changes: { from: dependency.from, to: dependency.to, insert: replacement },
            userEvent: "input.dependency",
          });
        },
      },
    ];
  });
}

export function versionCompletions(item: DependencyVersions, ctx: CompletionContext): CompletionResult {
  const { dependency, versions } = item;
  const typed = ctx.state.sliceDoc(dependency.from, ctx.pos);
  const prefix = /^[\s^~<>=]*/.exec(typed)?.[0] ?? "";
  const filter = typed.slice(prefix.length);
  return {
    from: dependency.from,
    to: dependency.to,
    filter: false,
    options: versions
      .filter((v) => ctx.explicit || v.startsWith(filter))
      .map((version) => ({
        label: version,
        type: "constant",
        detail: dependency.package,
        apply: prefix + version,
      })),
  };
}

const cargoCheck: ManifestCheck<DependencyVersions[]> = {
  inspection: DEPENDENCY_INSPECTION,
  producer: DEPENDENCY_PRODUCER,
  fetch: (doc, id) => call(commands.dependencyVersions(doc.doc, null, id)),
  apply(view, items, text) {
    view.dispatch({ effects: [setVersions.of(items), intentionsChanged.of(null)] });
    return items.flatMap(({ dependency, update }) => {
      if (!update) return [];
      const { latest } = update;
      return [
        {
          range: offsetsToRange(text, dependency.from, dependency.to),
          severity: "info" as const,
          message: tx`A newer version is available: ${latest}`,
          source: "Cargo",
          code: null,
        },
      ];
    });
  },
};

function extension(doc: EditorDocContext): Extension {
  const plugin = manifestCheck(doc, cargoCheck);
  return [
    versionsField,
    plugin,
    intentionProviders.of((view) => {
      const selection = view.state.selection.main;
      return dependencyFixes(view, selection.from, selection.to);
    }),
    quickFixProviders.of(dependencyFixes),
    versionCompletion(doc),
  ];
}

function versionCompletion(doc: EditorDocContext): Extension {
  const completion = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (!isTauri()) return null;
    const id = nextRequestId();
    const text = ctx.state.doc;
    const root = useProject.getState().project?.root;
    ctx.addEventListener("abort", () => void commands.cancelRequest(id), { onDocChange: true });
    try {
      // The completion context is immutable; only use it while its document is current.
      const view = ctx.view;
      if (!view) return null;
      await whenSynced(view);
      if (ctx.aborted || view.state.doc !== text) return null;
      const items = await call(commands.dependencyVersions(doc.doc, ctx.pos, id));
      if (ctx.aborted || view.state.doc !== text || useProject.getState().project?.root !== root) return null;
      const item = items.find(({ dependency }) => dependency.from <= ctx.pos && ctx.pos <= dependency.to);
      return item ? versionCompletions(item, ctx) : null;
    } catch {
      return null;
    }
  };
  return EditorState.languageData.of(() => [{ openideaCompletion: completion }]);
}

export function activate(): () => void {
  const offPython = registerPythonRequirements();
  const offEditor = registerEditorContribution({
    id: "dependency-versions",
    extensions: (doc) => {
      if (doc.virtual || doc.readOnly) return [];
      if (/(?:^|\/)Cargo\.toml$/.test(doc.path)) return extension(doc);
      if (/(?:^|\/)(?:go\.mod|package\.json)$/.test(doc.path)) return versionCompletion(doc);
      if (isPythonManifest(doc.path)) return pythonRequirements(doc);
      return [];
    },
  });
  return () => {
    offEditor();
    offPython();
  };
}
