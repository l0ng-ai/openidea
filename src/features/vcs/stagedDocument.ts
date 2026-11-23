import { history, indentWithTab, redo, undo } from "@codemirror/commands";
import {
  Compartment,
  EditorState,
  Transaction,
  type ChangeSet,
  type ChangeSpec,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { useEffect, useState, type RefObject } from "react";
import { createStore } from "zustand/vanilla";
import type { StagedText } from "@/bindings";
import { remoteChange, isExternalChange } from "@/editor/api";
import { editorHistoryKeymap } from "@/editor/core/cm/baseKeymap";
import { executeAction } from "@/platform/actions";
import { auxiliaryWindow } from "@/platform/auxWindow";
import { tx } from "@/platform/i18n";
import { call, commands, isErrorKind } from "@/platform/ipc";
import { bindingsFor, normalizeBinding, registerKeyClaim } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import {
  notifications,
  notifyEditorDocumentChanged,
  type EditorDocumentLifecycle,
  type EditorInput,
} from "@/workbench/contributions";
import { stripSlash } from "./model";
import { errorMessage } from "./ops";
import { refreshNow, statusOf, useVcs } from "./store";
import { isIndex, type DiffData } from "./diffInput";
import { confirmDialog } from "./dialogs";
import { stagingVersions } from "./stagingVersions";

const initial = { loading: true, error: "", closing: false, base: null as StagedText | null, text: "" };
export const emptyStagedStatus = createStore(() => initial);

function projectRoot(): string | null {
  return useProject.getState().project?.root ?? (auxiliaryWindow()?.kind === "diff" ? useVcs.getState().root : null);
}

export class StagedDocument {
  readonly status = createStore(() => initial);
  private state = EditorState.create({ extensions: history() });
  private readonly views = new Map<EditorView, Compartment>();
  private readonly listeners = new Set<(changes: ChangeSet) => void>();
  private readonly closing = new Set<string>();
  private read?: Promise<void>;
  private write?: Promise<void>;
  private disposed = false;
  private readonly unsubscribe = useVcs.subscribe((state, prev) => {
    if (state.version !== prev.version && !this.dirty && !this.write) void this.reload();
  });

  constructor(
    readonly project: string,
    readonly path: string,
  ) {}

  get dirty() {
    const { base, text } = this.status.getState();
    return !!base && base.text !== text;
  }

  private get readOnly() {
    return !this.status.getState().base || this.closing.size > 0;
  }

  private access(): Extension {
    return [EditorState.readOnly.of(this.readOnly), EditorView.editable.of(!this.readOnly)];
  }

  private updateAccess() {
    for (const [view, access] of this.views) view.dispatch({ effects: access.reconfigure(this.access()) });
  }

  private accept(tr: Transaction, source?: EditorView) {
    const wasDirty = this.dirty;
    this.state = tr.state;
    for (const view of this.views.keys()) {
      if (view === source || !tr.docChanged) continue;
      view.dispatch({
        changes: tr.changes,
        selection: view.hasFocus && (tr.isUserEvent("undo") || tr.isUserEvent("redo")) ? tr.newSelection : undefined,
        annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
      });
    }
    if (tr.docChanged) for (const listener of this.listeners) listener(tr.changes);
    this.status.setState({ text: this.state.doc.toString() });
    if (this.dirty !== wasDirty) notifyEditorDocumentChanged();
  }

  private reset(base: StagedText | null) {
    const text = base?.text ?? "";
    // Keep history on a no-op refresh following our own save.
    if (this.state.doc.toString() !== text) {
      const tr = this.state.update({ changes: { from: 0, to: this.state.doc.length, insert: text } });
      this.accept(tr);
      this.state = EditorState.create({ doc: this.state.doc, extensions: history() });
    }
    this.status.setState({ base, error: base ? "" : tx("No editable staged version") });
    this.updateAccess();
    notifyEditorDocumentChanged();
  }

  reload(discard = false): Promise<void> {
    if (this.read) return discard ? this.read.then(() => this.reload(true)) : this.read;
    if (this.disposed || this.write || (this.dirty && !discard)) return Promise.resolve();
    const requested = this.state.doc;
    this.read = call(commands.vcsStagedText(this.path))
      .then((snapshot) => {
        if (!this.disposed && !this.write && this.state.doc === requested) this.reset(snapshot);
      })
      .catch((error) => {
        if (!this.disposed) this.status.setState({ error: errorMessage(error) });
      })
      .finally(() => {
        this.read = undefined;
        if (!this.disposed) this.status.setState({ loading: false });
      });
    return this.read;
  }

  save(): Promise<void> {
    if (this.write) return this.write.then(() => this.save());
    const { base, text } = this.status.getState();
    if (!base || !this.dirty) return Promise.resolve();
    if (projectRoot() !== this.project) return Promise.reject(new Error(tx("The open project has changed")));
    this.write = call(commands.vcsSaveStagedText(this.path, base.version, text))
      .then((version) => {
        this.status.setState({ base: { version, text }, error: "" });
        notifyEditorDocumentChanged();
        void refreshNow();
      })
      .catch((error) => {
        this.status.setState({
          error: isErrorKind(error, "outOfSync") ? tx("The staged version changed on disk") : errorMessage(error),
        });
        throw error;
      })
      .finally(() => {
        this.write = undefined;
      });
    return this.write;
  }

  edit(changes: ChangeSpec) {
    if (!this.readOnly) this.accept(this.state.update({ changes, userEvent: "input.git" }));
  }

  subscribeChanges(listener: (changes: ChangeSet) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private change(update: ViewUpdate) {
    if (!update.docChanged || this.readOnly) return;
    for (const tr of update.transactions) {
      if (!tr.docChanged || isExternalChange(tr)) continue;
      const userEvent = tr.annotation(Transaction.userEvent);
      this.accept(
        this.state.update({
          changes: tr.changes,
          selection: tr.newSelection,
          userEvent,
        }),
        update.view,
      );
    }
  }

  extension(): Extension {
    const access = new Compartment();
    return [
      access.of(this.access()),
      EditorState.changeFilter.of((tr) => !this.readOnly || isExternalChange(tr)),
      ViewPlugin.define((view) => {
        this.views.set(view, access);
        return { destroy: () => void this.views.delete(view) };
      }),
      EditorView.updateListener.of((update) => this.change(update)),
      keymap.of([
        ...editorHistoryKeymap.map((key) => {
          if (key.run === undo) return { ...key, run: () => this.history(undo) };
          if (key.run === redo) return { ...key, run: () => this.history(redo) };
          return key;
        }),
        indentWithTab,
      ]),
    ];
  }

  activeView(): EditorView | undefined {
    return [...this.views.keys()].find((view) => view.hasFocus) ?? this.views.keys().next().value;
  }

  history(command: typeof undo): boolean {
    if (this.readOnly) return false;
    return command({ state: this.state, dispatch: (tr) => this.accept(tr) });
  }

  async prepareClose(owner: string) {
    this.cancelClose(owner, true);
    await this.write?.catch(() => {});
  }

  cancelClose(owner: string, closing = false) {
    if (closing) this.closing.add(owner);
    else this.closing.delete(owner);
    this.status.setState({ closing: this.closing.size > 0 });
    this.updateAccess();
  }

  discard() {
    this.reset(this.status.getState().base);
  }

  dispose() {
    this.disposed = true;
    this.unsubscribe();
  }
}

const documents = new Map<string, StagedDocument>();
const owners = new Map<string, StagedDocument>();
const transientOwners = new Map<string, symbol>();

export function stagedDocument(path: string, owner: string): StagedDocument | null {
  const root = projectRoot();
  if (!root) return null;
  path = stripSlash(path);
  const key = `${root}\0${path}`;
  const doc = documents.get(key) ?? new StagedDocument(root, path);
  documents.set(key, doc);
  owners.set(owner, doc);
  return doc;
}

export function ownedStagedDocument(owner: string) {
  return owners.get(owner);
}

export function stagedDiffPath(data: DiffData): string | null {
  const side = data.middle ?? (isIndex(data.left) ? data.left : data.right);
  return isIndex(side) ? (side.path ?? data.path) : null;
}

export function currentStagedDiffPath(data: DiffData, versions?: DiffData): string | null {
  if (!data.middle) return stagedDiffPath(data);
  const status = statusOf(data.path);
  const current = versions ?? (status && stagingVersions(status)) ?? data;
  return stagedDiffPath(current) ?? stagedDiffPath(data);
}

export async function reloadStagedDocument(doc: StagedDocument) {
  if (
    !doc.dirty ||
    (await confirmDialog({
      title: "Reload Staged Version",
      message: tx("Discard your edits and reload the staged version?"),
      okLabel: "Reload",
    }))
  )
    await doc.reload(true);
}

export function useEmbeddedStagedSave(
  embedded: boolean,
  doc: StagedDocument | null,
  root: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!embedded || !doc) return;
    return registerKeyClaim((event, stroke) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) return false;
      if (!bindingsFor("file.save").some((key) => normalizeBinding(key) === stroke)) return false;
      event.preventDefault();
      event.stopPropagation();
      void doc.save().catch(() => {}); // The staged pane shows the failed save.
      return true;
    });
  }, [embedded, doc, root]);
}

export function stagedDocumentAtPath(path: string) {
  return documents.get(`${projectRoot()}\0${stripSlash(path)}`);
}

function release(owner: string) {
  const doc = owners.get(owner);
  owners.delete(owner);
  doc?.cancelClose(owner);
  if (doc) prune(doc);
}

function prune(doc: StagedDocument) {
  if (doc.dirty || [...owners.values()].includes(doc)) return;
  doc.dispose();
  documents.delete(`${doc.project}\0${doc.path}`);
}

export function useStagedDiffDocument(path: string | null, owner: string, transient: boolean) {
  const [doc, setDoc] = useState<StagedDocument | null>(null);
  const project = projectRoot();
  useEffect(() => {
    const active = path && stagedDocument(path, owner);
    if (!active) return;
    const lease = Symbol();
    if (transient) transientOwners.set(owner, lease);
    let alive = true;
    void active.reload().then(() => {
      if (!alive) return;
      setDoc(active);
      if (active.dirty) notifyEditorDocumentChanged();
    });
    return () => {
      alive = false;
      void active
        .save()
        .catch((error) => {
          if (!transient) return; // The tab still owns the draft and displays the error.
          notifications().notify({
            group: "vcs",
            level: "error",
            title: tx("Could not save diff"),
            body: errorMessage(error),
            actions: [
              { label: "Show Staged Version", run: () => void executeAction("vcs.showStagedVersion", active.path) },
            ],
          });
        })
        .finally(() => {
          if (transient && transientOwners.get(owner) === lease) {
            transientOwners.delete(owner);
            release(owner);
          }
          prune(active);
        });
    };
  }, [path, owner, transient, project]);
  return path && doc?.path === stripSlash(path) && doc.project === project ? doc : null;
}

export function saveStagedDocuments(): Promise<void> {
  return Promise.all(
    [...documents.values()].filter((doc) => doc.project === projectRoot()).map((doc) => doc.save()),
  ).then(() => {});
}

export function stagedDocumentLifecycle(
  inDiff = false,
  ownerKeys: (input: EditorInput) => string[] = ({ key }) => [key],
): EditorDocumentLifecycle {
  const owned = (input: EditorInput) =>
    ownerKeys(input).flatMap((key) => {
      const doc = owners.get(key);
      return doc ? [{ key, doc }] : [];
    });
  return {
    allowPreview: inDiff,
    isDirty: (input) => owned(input).some(({ doc }) => doc.dirty),
    flush: async () => {},
    save: async (input) => {
      for (const { doc } of owned(input)) await doc.save();
    },
    prepareClose: async (input) => {
      for (const { key, doc } of owned(input)) {
        await doc.prepareClose(key);
        if (inDiff) await doc.save();
      }
    },
    cancelClose: (input) => {
      for (const { key, doc } of owned(input)) doc.cancelClose(key);
    },
    discard: async (input) => {
      for (const { doc } of owned(input)) doc.discard();
    },
    close: async (input) => {
      for (const key of ownerKeys(input)) release(key);
    },
    handlesHistory: (input) => !inDiff || owned(input).some(({ doc }) => doc.activeView()?.hasFocus),
    undo: async (input) => {
      const docs = owned(input);
      (docs.find(({ doc }) => doc.activeView()?.hasFocus) ?? docs[0])?.doc.history(undo);
    },
    redo: async (input) => {
      const docs = owned(input);
      (docs.find(({ doc }) => doc.activeView()?.hasFocus) ?? docs[0])?.doc.history(redo);
    },
  };
}
