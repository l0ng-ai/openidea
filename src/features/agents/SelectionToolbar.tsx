/**
 * Floating toolbar above a selection in the conversation: quote it into the composer
 * ("Reply"), or start a temporary side conversation about it.
 */
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";
import clsx from "clsx";
import type { AgentTask } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { T } from "@/ui";
import { isBusy } from "./model";
import { selectionIn } from "./selection";
import styles from "./SelectionToolbar.module.css";

/** What a shown toolbar acts on: the selection and where it sits. */
interface Shown {
  text: string;
  /** Selection range and the stream's visible band, viewport-relative at the moment it was shown. */
  range: { left: number; top: number; bottom: number };
  stream: { left: number; right: number; top: number; bottom: number };
}

/** Toolbar dimensions before the first layout measured them; only clamping leans on them. */
const ESTIMATED = { width: 200, height: 26 };

/** Just above the selection, below it when there is no room, within the stream's visible band. */
function place(shown: Shown, size: { width: number; height: number }): { left: number; top: number } {
  const margin = 6;
  const { width, height } = size.width ? size : ESTIMATED;
  const left = Math.min(
    Math.max(shown.range.left, shown.stream.left + margin),
    Math.max(shown.stream.left + margin, shown.stream.right - width - margin),
  );
  const above = shown.range.top - height - margin;
  const top = above >= shown.stream.top + margin ? above : shown.range.bottom + margin;
  return {
    left,
    top: Math.min(Math.max(top, shown.stream.top + margin), Math.max(margin, shown.stream.bottom - height - margin)),
  };
}

export function SelectionToolbar({
  streamRef,
  task,
  subagent,
}: {
  streamRef: RefObject<HTMLDivElement | null>;
  task: AgentTask;
  /** The conversation shown belongs to a subagent: side conversations fork the task's own. */
  subagent: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const hide = useEffectEvent(() => setShown(null));

  /** Shows the toolbar over the selection, when there is one to act on. */
  const show = useEffectEvent(() => {
    const stream = streamRef.current;
    if (!stream || task.status === "archived") return hide();
    const text = selectionIn(stream);
    const selection = stream.ownerDocument.getSelection();
    if (!text.trim() || !selection?.rangeCount) return hide();
    const range = selection.getRangeAt(0);
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    // A selection in an editable field edits that field, not the conversation.
    if (!start || start.closest("input, textarea, [contenteditable='true'], .cm-editor")) return hide();
    const box = range.getBoundingClientRect();
    const view = stream.getBoundingClientRect();
    setShown({
      text,
      range: { left: box.left, top: box.top, bottom: box.bottom },
      stream: { left: view.left, right: view.right, top: view.top, bottom: view.bottom },
    });
  });

  useEffect(() => {
    const stream = streamRef.current;
    const doc = stream?.ownerDocument;
    if (!stream || !doc) return;
    // Anything that starts a new selection, or moves the conversation, hides it again.
    const collapsed = () => {
      const selection = doc.getSelection();
      if (!selection || selection.isCollapsed) hide();
    };
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) hide();
    };
    const up = (e: MouseEvent) => {
      if (e.button === 0 && !ref.current?.contains(e.target as Node)) show();
    };
    stream.addEventListener("scroll", hide);
    doc.addEventListener("mousedown", down);
    doc.addEventListener("mouseup", up);
    doc.addEventListener("selectionchange", collapsed);
    return () => {
      stream.removeEventListener("scroll", hide);
      doc.removeEventListener("mousedown", down);
      doc.removeEventListener("mouseup", up);
      doc.removeEventListener("selectionchange", collapsed);
    };
  }, [streamRef]);

  // The first placement clamps against the real dimensions, known after one layout.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !shown) return;
    const { offsetWidth, offsetHeight } = el;
    setSize((s) =>
      s.width === offsetWidth && s.height === offsetHeight ? s : { width: offsetWidth, height: offsetHeight },
    );
  }, [shown]);

  // A side conversation works on any live task: it starts a session of its own.
  const side = !!shown && !subagent && task.status !== "archived" && !isBusy(task.status);

  const startSide = () => {
    if (!shown) return;
    setShown(null);
    void executeAction("agents.startSideConversation", { task: task.id, text: shown.text });
  };

  return (
    <div
      ref={ref}
      className={clsx(styles.toolbar, shown && styles.visible)}
      style={shown ? place(shown, size) : undefined}
      // Clicking a button keeps the selection it acts on.
      onMouseDown={(e) => e.preventDefault()}
    >
      {shown && (
        <>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              if (!shown) return;
              setShown(null);
              void executeAction("agents.quoteReply", { task: task.id, text: shown.text });
            }}
          >
            <T>Reply</T>
          </button>
          {side && (
            <button type="button" className={styles.button} onClick={startSide}>
              <T>Start Side Conversation</T>
            </button>
          )}
        </>
      )}
    </div>
  );
}
