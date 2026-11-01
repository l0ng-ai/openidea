import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import {
  intentionProviders,
  intentionsChanged,
  quickFixProviders,
  registerEditorContribution,
  whenSynced,
  type ContributedIntention,
  type EditorDocContext,
} from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { offsetsToRange } from "@/editor/lsp/positions";
import { call, commands, isTauri, nextRequestId, type DependencyVersions, type RequestId } from "@/platform/ipc";
import {
  DEPENDENCY_INSPECTION,
  DEPENDENCY_PRODUCER,
  inspectionProfile,
  subscribeInspectionProfile,
} from "@/platform/inspections";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";

const setVersions = StateEffect.define<DependencyVersions[]>();
const versionsField = StateField.define<DependencyVersions[]>({
  create: () => [],
  update(value, tr) {
    if (tr.docChanged) return [];
    for (const effect of tr.effects) if (effect.is(setVersions)) return effect.value;
    return value;
  },
});

const viewers = new Map<string, number>();

const enabled = () => inspectionProfile()[DEPENDENCY_INSPECTION]?.enabled !== false;

export function dependencyFixes(view: EditorView, from: number, to: number): ContributedIntention[] {
  if (!enabled() || view.state.readOnly) return [];
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

function extension(doc: EditorDocContext): Extension {
  const plugin = ViewPlugin.define((view) => {
    if (!isTauri()) return {};
    viewers.set(doc.path, (viewers.get(doc.path) ?? 0) + 1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: RequestId | null = null;
    let sequence = 0;
    let disposed = false;
    const clear = () => setFileDiagnostics(doc.path, DEPENDENCY_PRODUCER, []);
    const cancel = () => {
      sequence++;
      if (request !== null) void commands.cancelRequest(request);
      request = null;
    };
    const run = async () => {
      if (disposed || !enabled()) return;
      const mine = sequence;
      const text = view.state.doc;
      const root = useProject.getState().project?.root;
      const id = nextRequestId();
      request = id;
      try {
        await whenSynced(view);
        if (mine !== sequence || disposed) return;
        const items = await call(commands.dependencyVersions(doc.doc, null, id));
        if (mine !== sequence || disposed || view.state.doc !== text || useProject.getState().project?.root !== root)
          return;
        view.dispatch({ effects: [setVersions.of(items), intentionsChanged.of(null)] });
        setFileDiagnostics(
          doc.path,
          DEPENDENCY_PRODUCER,
          items.flatMap(({ dependency, update }) => {
            if (!update) return [];
            const { latest } = update;
            return [
              {
                range: offsetsToRange(text, dependency.from, dependency.to),
                severity: "info",
                message: tx`A newer version is available: ${latest}`,
                source: "Cargo",
                code: null,
              },
            ];
          }),
        );
      } catch {
        // Offline registries and cancelled checks never interrupt editing.
      } finally {
        if (request === id) request = null;
      }
    };
    const schedule = () => {
      cancel();
      clear();
      clearTimeout(timer);
      timer = setTimeout(() => void run(), 500);
    };
    schedule();
    const offProfile = subscribeInspectionProfile(() => {
      schedule();
      view.dispatch({ effects: intentionsChanged.of(null) });
    });
    const offProject = useProject.subscribe((state, previous) => {
      if (state.project?.root !== previous.project?.root) {
        disposed = true;
        cancel();
        clearTimeout(timer);
        clear();
      }
    });
    return {
      update: (u) => {
        if (u.docChanged) schedule();
      },
      destroy: () => {
        disposed = true;
        cancel();
        clearTimeout(timer);
        offProfile();
        offProject();
        const remaining = (viewers.get(doc.path) ?? 1) - 1;
        if (remaining) viewers.set(doc.path, remaining);
        else {
          viewers.delete(doc.path);
          clear();
        }
      },
    };
  });
  const completion = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (!isTauri()) return null;
    const id = nextRequestId();
    const text = ctx.state.doc;
    const root = useProject.getState().project?.root;
    ctx.addEventListener("abort", () => void commands.cancelRequest(id));
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
  return [
    versionsField,
    plugin,
    intentionProviders.of((view) => {
      const selection = view.state.selection.main;
      return dependencyFixes(view, selection.from, selection.to);
    }),
    quickFixProviders.of(dependencyFixes),
    EditorState.languageData.of(() => [{ openideaCompletion: completion }]),
  ];
}

export function activate(): () => void {
  return registerEditorContribution({
    id: "dependency-versions",
    extensions: (doc) => (!doc.virtual && !doc.readOnly && /(?:^|\/)Cargo\.toml$/.test(doc.path) ? extension(doc) : []),
  });
}
