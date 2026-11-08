/**
 * The diff "window" of the modal commit interface (#1863): diffs open in front, not in
 * an editor tab that the modal Commit dialog would hide. A `Dialog` stacked on
 * `openDialog`'s stack keeps whatever is underneath (the Commit dialog and its message,
 * selection and options, a comparison list) mounted; Esc / the close button / the
 * close-tab chord return to it. F7 / Shift+F7 and the diff navigation actions move
 * along the file's change chain by swapping this dialog's content.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { bindingsFor, normalizeBinding, registerKeyClaim } from "@/platform/keymap";
import { Dialog } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { DiffEditor } from "./DiffEditor";
import { diffInput, diffTitle, type DiffData } from "./diffInput";
import { openDialog } from "./dialogs";
import { GitMergeDiff } from "./GitMergeDiff";

/** The open diff dialog's close function (one diff window at a time, as in IDEA). */
let shown: (() => void) | null = null;

/** Shows `render`'s window, replacing the open diff window instead of stacking another on top. */
function showFront(render: (onClose: () => void) => ReactNode): () => void {
  shown?.();
  shown = null;
  const close = openDialog((c) =>
    render(() => {
      if (shown === close) shown = null;
      c();
    }),
  );
  shown = close;
  return () => {
    if (shown === close) shown = null;
    close();
  };
}

/** Opens `data` in a front dialog; returns its close function. */
export function openDiffDialog(data: DiffData): () => void {
  return showFront((onClose) => <DiffDialog data={data} onClose={onClose} />);
}

/** Opens a merge commit's file (parent ↔ merge result ↔ parent, a `git-merge-diff` input) in front. */
export function openMergeDiffDialog(input: EditorInput): () => void {
  const title = (input.data as { path: string }).path;
  return showFront((onClose) => (
    <FrontWindow title={title} onClose={onClose}>
      <GitMergeDiff input={input} />
    </FrontWindow>
  ));
}

function FrontWindow({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      registerKeyClaim((e, stroke) => {
        const dialog = body.current?.closest('[role="dialog"]');
        if (!dialog || !(e.target instanceof Element) || e.target.closest('[role="dialog"]') !== dialog) return false;
        if (!bindingsFor("toolwindow.closeContent").some((b) => normalizeBinding(b) === stroke)) return false;
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return true;
      }),
    [onClose],
  );
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      width="calc(100vw - 64px)"
      resizable="both"
      minWidth={480}
      minHeight={280}
      initialSize={{ w: Math.min(1100, globalThis.innerWidth - 64), h: Math.min(720, globalThis.innerHeight - 64) }}
      buttons={[{ label: "Close", role: "cancel" }]}
    >
      <div
        ref={body}
        className="vcsDiffDialogBody"
        style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
      >
        {children}
      </div>
    </Dialog>
  );
}

function DiffDialog({ data: initial, onClose }: { data: DiffData; onClose: () => void }) {
  const [data, setData] = useState(initial);
  const input = diffInput({ ...data, embedded: true });
  return (
    <FrontWindow title={diffTitle(data)} onClose={onClose}>
      <DiffEditor key={input.key} input={input} onNeighbour={setData} onJumpToSource={onClose} />
    </FrontWindow>
  );
}
