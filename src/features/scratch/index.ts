/**
 * Scratch Files (⇧⌘N): throwaway files in any language, stored in the app
 * data dir and listed under "Scratches" in the Project view.
 */
import type { EditorView } from "@codemirror/view";
import { intentionProviders, registerEditorContribution, type ContributedIntention } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { registerActions } from "@/platform/actions";
import { onFileOperation } from "@/platform/fileOps";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { useRemote } from "@/platform/remote";
import { registerMenuGroup, registerOverlay, registerProjectViewRoot } from "@/workbench/contributions";
import { ScratchChooserHost } from "./ScratchChooser";
import { openChooser } from "./store";
import {
  createScratchFromSelection,
  newScratchBuffer,
  scratchBackend,
  scratchesAvailable,
  scratchesDir,
} from "./scratches";

export { newScratchBuffer };

export const SCRATCHES_ROOT_LABEL = "Scratches";

export async function newScratchFile() {
  openChooser(await scratchBackend().languages());
}

/** IDEA's Create New Scratch File from Selection, available only for a non-empty selection. */
export function scratchFromSelectionIntentions(view: EditorView): ContributedIntention[] {
  if (!scratchesAvailable()) return [];
  const state = view.state;
  const selection = state.selection.main;
  const source = docOf(view);
  if (!source || selection.empty) return [];
  const text = state.doc.sliceString(selection.from, selection.to);
  return [
    {
      id: "scratch.createFromSelection",
      label: tx("Create new scratch file from selection"),
      icon: "scratches",
      run: async () => {
        // The popup may have been open while the source document or selection changed.
        if (view.state.doc !== state.doc || !view.state.selection.main.eq(selection)) return;
        const current = docOf(view);
        if (current) await createScratchFromSelection(current, text);
      },
    },
  ];
}

export function activate(): () => void {
  let disposed = false;
  let unregisterRoot = () => {};
  let dir: string | null = null;
  let generation = 0;
  const registerRoot = () => {
    const current = ++generation;
    unregisterRoot();
    unregisterRoot = () => {};
    dir = null;
    void scratchesDir()
      .then((path) => {
        if (disposed || current !== generation) return;
        dir = path;
        unregisterRoot = registerProjectViewRoot({
          id: "scratches",
          label: SCRATCHES_ROOT_LABEL,
          icon: "scratches",
          path,
          order: 10,
          scope: "scratches",
        });
      })
      .catch((e: unknown) => console.warn("scratch files: no scratches folder", e));
  };
  if (scratchesAvailable()) registerRoot();
  const disposers = [
    registerEditorContribution({
      id: "scratch.fromSelection",
      extensions: () => intentionProviders.of(scratchFromSelectionIntentions),
    }),
    // Attaching to (or leaving) a remote server moves the scratches to that host.
    useRemote.subscribe((state, previous) => {
      if (state.session !== previous.session && scratchesAvailable()) registerRoot();
    }),
    // The file watcher covers the project only: deleted scratches close their editors like watched files.
    onFileOperation((op) => {
      const removed = dir && op.kind === "deleted" ? op.paths.filter((p) => p === dir || p.startsWith(`${dir}/`)) : [];
      if (removed.length) emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [], removed });
    }),
    registerOverlay({ id: "scratch.chooser", component: ScratchChooserHost }),
    // IDEA lists it near the top of the New popup.
    registerMenuGroup({
      id: "scratch.new",
      menus: ["new"],
      order: 0,
      items: () => [{ kind: "action", action: "file.newScratchFile", label: "Scratch File" }],
    }),
    registerActions([
      {
        id: "file.newScratchFile",
        title: "New Scratch File…",
        category: "File",
        icon: "scratches",
        keywords: ["scratch", "temporary file", "buffer"],
        when: "projectOpen",
        run: () => newScratchFile(),
      },
      {
        id: "file.newScratchBuffer",
        title: "New Scratch Buffer",
        category: "File",
        icon: "scratches",
        keywords: ["scratch", "temporary file", "buffer", "plain text"],
        when: "projectOpen",
        run: async () => {
          await newScratchBuffer();
        },
      },
    ]),
  ];
  return () => {
    disposed = true;
    unregisterRoot();
    disposers.reverse().forEach((d) => d());
  };
}
