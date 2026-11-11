import { useEffect, useState, type RefObject } from "react";
import type { AgentTask } from "@/bindings";
import { IconButton, Popup } from "@/ui";

/** Text selected in `stream`, or "" when the selection is elsewhere. */
export function selectionIn(stream: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  return stream.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.toString() : "";
}

interface Quote {
  range: Range;
  text: string;
}

/**
 * Logic: the mouse selection that just ended inside `stream`, or null. It is cleared when the
 * selection collapses or the stream scrolls; `clear` hides it on demand.
 */
function useSelectionQuote(streamRef: RefObject<HTMLElement | null>): [Quote | null, () => void] {
  const [quote, setQuote] = useState<Quote | null>(null);

  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const hide = () => setQuote(null);
    const onMouseUp = (e: MouseEvent) => {
      const text = selectionIn(stream);
      setQuote(
        e.button === 0 && text.trim() ? { range: window.getSelection()!.getRangeAt(0).cloneRange(), text } : null,
      );
    };
    const onSelectionChange = () => {
      if (!selectionIn(stream).trim()) hide();
    };
    stream.addEventListener("mouseup", onMouseUp);
    stream.addEventListener("scroll", hide);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      stream.removeEventListener("mouseup", onMouseUp);
      stream.removeEventListener("scroll", hide);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [streamRef]);

  return [quote, () => setQuote(null)];
}

/**
 * View: a small Quote button above the end of the selection. Escape and a click elsewhere
 * close it through the Popup.
 */
export function SelectionQuote({ task, streamRef }: { task: AgentTask; streamRef: RefObject<HTMLElement | null> }) {
  const [quote, clear] = useSelectionQuote(streamRef);
  if (!quote || task.status === "archived") return null;
  return (
    <Popup open anchor={quote.range} placement="top-end" autoFocus={false} restoreFocus={false} onClose={clear}>
      <IconButton
        icon="quote"
        title="Quote"
        size="small"
        action="agents.quoteReply"
        actionArg={{ task: task.id, text: quote.text }}
        onClick={clear}
      />
    </Popup>
  );
}
