/** Workspace edits contribute history markers; their text patches never enter local history. */
import { invertedEffects, isolateHistory, redo, undo } from "@codemirror/commands";
import { EditorState, Prec, StateEffect, type Transaction, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { _provideWorkspaceHistory, isExternalChange } from "@/editor/api";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";

interface Marker {
  id: number;
  redo: boolean;
}
const marker = StateEffect.define<Marker>();

export interface WorkspaceHistoryTarget {
  path: string;
  state(): EditorState;
  dispatch(tr: Transaction): void;
}

export class WorkspaceHistory {
  private targets = new Set<WorkspaceHistoryTarget>();
  private records = new Map<number, { paths: string[]; undone: boolean }>();
  private project = useProject.getState().project;
  private busy = false;
  private moving = false;

  constructor(
    private synced: () => Promise<void>,
    private notify: (n: { level: "error"; title: string; body: string }) => void,
  ) {}

  start(): () => void {
    const stop = onIdeEvent("workspaceEditApplied", ({ id, paths }) => {
      if (this.project !== useProject.getState().project) {
        this.records.clear();
        this.project = useProject.getState().project;
      }
      this.records.set(id, { paths, undone: false });
      while (this.records.size > 20) this.records.delete(this.records.keys().next().value!);
      for (const target of this.targets) if (this.affects(paths, target.path)) this.mark(target, id);
    });
    const unprovide = _provideWorkspaceHistory((id, redo) => this.run(id, redo));
    return () => {
      stop();
      unprovide();
      this.records.clear();
    };
  }

  private affects(paths: string[], path: string) {
    return paths.some((root) => path === root || path.startsWith(`${root}/`));
  }

  attach(target: WorkspaceHistoryTarget): () => void {
    this.targets.add(target);
    for (const [id, record] of this.records) {
      if (!record.undone && this.affects(record.paths, target.path)) this.mark(target, id);
    }
    return () => this.targets.delete(target);
  }

  extension(target: WorkspaceHistoryTarget): Extension {
    return [
      Prec.highest(
        keymap.of([
          { key: "Mod-z", run: () => this.busy },
          { key: "Mod-Shift-z", run: () => this.busy },
          { key: "Mod-y", run: () => this.busy },
        ]),
      ),
      Prec.highest(
        EditorView.domEventHandlers({
          beforeinput: (event) => {
            if (this.busy && (event.inputType === "historyUndo" || event.inputType === "historyRedo")) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        }),
      ),
      invertedEffects.of((tr) =>
        tr.effects.filter((e) => e.is(marker)).map((e) => marker.of({ id: e.value.id, redo: !e.value.redo })),
      ),
      // History commands disable transaction filters. An extender observes the
      // effect-only history step, including native beforeinput and direct CM undo.
      EditorState.transactionExtender.of((tr) => {
        if (!this.moving && (tr.isUserEvent("undo") || tr.isUserEvent("redo"))) {
          const entry = tr.effects.find((e) => e.is(marker));
          if (entry)
            void this.run(entry.value.id, entry.value.redo, target).catch((error: unknown) => {
              this.notify({
                level: "error",
                title: "Cannot undo refactoring",
                body: String(error instanceof Error ? error.message : error),
              });
            });
        }
        return null;
      }),
      EditorState.changeFilter.of((tr) => !this.busy || isExternalChange(tr)),
    ];
  }

  private mark(target: WorkspaceHistoryTarget, id: number) {
    target.dispatch(
      target.state().update({ effects: marker.of({ id, redo: true }), annotations: isolateHistory.of("full") }),
    );
  }

  /** Inspect the next history step without dispatching it or starting another request. */
  private step(target: WorkspaceHistoryTarget, id: number, forward: boolean): Transaction | null {
    let result: Transaction | null = null;
    this.moving = true;
    try {
      (forward ? redo : undo)({
        state: target.state(),
        dispatch: (tr) => {
          if (tr.effects.some((e) => e.is(marker) && e.value.id === id && e.value.redo === forward)) result = tr;
        },
      });
    } finally {
      this.moving = false;
    }
    return result;
  }

  async run(id: number, forward = false, source?: WorkspaceHistoryTarget): Promise<void> {
    if (this.busy) throw new Error("A refactoring history operation is in progress");
    this.busy = true;
    try {
      // Yield before reading a source: its marker transaction is still being built.
      await this.synced();
      if (this.project !== useProject.getState().project)
        throw new Error("The project for this refactoring is no longer open");
      const record = this.records.get(id);
      if (!record || record.undone !== forward) throw new Error("The refactoring can no longer be undone");
      const targets = [...this.targets].filter((t) => t !== source && this.affects(record.paths, t.path));
      for (const target of targets)
        if (!this.step(target, id, forward))
          throw new Error("Undo newer editor changes before undoing this refactoring");
      await call(forward ? commands.redoWorkspaceEdit(id) : commands.undoWorkspaceEdit(id));
      await this.synced();
      for (const target of targets) {
        if (!this.targets.has(target)) continue;
        const tr = this.step(target, id, forward);
        if (tr) target.dispatch(tr);
      }
      record.undone = !forward;
    } catch (error) {
      // A refused backend restore must leave the initiating editor's history intact.
      if (source && this.targets.has(source)) {
        const tr = this.step(source, id, !forward);
        if (tr) source.dispatch(tr);
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
