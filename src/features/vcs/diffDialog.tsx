/**
 * The diff "window" of the modal Commit dialog (#1863): activating a changed file
 * there opens the diff in front of the dialog, not in an editor tab behind it.
 * A `Dialog` stacked on `openDialog`'s stack keeps the Commit dialog (and its
 * message, selection and options) mounted underneath; Esc / the close button /
 * the close-tab chord return to it. F7 / Shift+F7 and the diff navigation actions
 * move along the file's change chain by swapping this dialog's content.
 */
import { useState, type KeyboardEvent } from "react";
import { bindingsFor, normalizeBinding, strokeOf } from "@/platform/keymap";
import { Dialog } from "@/ui";
import { DiffEditor } from "./DiffEditor";
import { diffInput, diffTitle, type DiffData } from "./diffInput";
import { openDialog } from "./dialogs";

/** Whether `e` is one of the strokes bound to `actionId`. */
function isStrokeOf(e: KeyboardEvent, actionId: string): boolean {
  const stroke = strokeOf(e.nativeEvent);
  return !!stroke && bindingsFor(actionId).some((b) => normalizeBinding(b) === stroke);
}

/** The open diff dialog's close function (one diff window at a time, as in IDEA). */
let shown: (() => void) | null = null;

/**
 * Opens `data` in a front dialog; returns its close function. A second activation
 * replaces the open diff window instead of stacking another on top.
 */
export function openDiffDialog(data: DiffData): () => void {
  shown?.();
  shown = null;
  const close = openDialog((c) => (
    <DiffDialog
      data={data}
      onClose={() => {
        if (shown === close) shown = null;
        c();
      }}
    />
  ));
  shown = close;
  return () => {
    if (shown === close) shown = null;
    close();
  };
}

function DiffDialog({ data: initial, onClose }: { data: DiffData; onClose: () => void }) {
  const [data, setData] = useState(initial);
  const input = diffInput({ ...data, embedded: true });
  return (
    <Dialog
      open
      title={diffTitle(data)}
      onClose={onClose}
      width="calc(100vw - 64px)"
      resizable="both"
      minWidth={480}
      minHeight={280}
      initialSize={{ w: Math.min(1100, globalThis.innerWidth - 64), h: Math.min(720, globalThis.innerHeight - 64) }}
      buttons={[{ label: "Close", role: "cancel" }]}
    >
      <div
        className="vcsDiffDialogBody"
        style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
        onKeyDown={(e) => {
          // The "close tab" chord would otherwise close an editor tab behind the modal.
          if (isStrokeOf(e, "toolwindow.closeContent")) {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <DiffEditor key={input.key} input={input} onNeighbour={setData} />
      </div>
    </Dialog>
  );
}
