import { createContext, useContext, useRef, useState, type ReactElement, type ReactNode } from "react";
import { flushSync } from "react-dom";

/** Set while Find in Conversation is open: folded sections render their content, so it is found. */
export const FoldedContent = createContext(false);

/**
 * Which keyed folds of a conversation the reader opened. A fold's row can remount (a run
 * grows from one call to two, a finished turn folds its work away); this keeps it as it was.
 */
export const OpenFolds = createContext<Map<string, boolean> | null>(null);

/** Puts a section's header back at `top` (viewport px) after the reader opened or closed it (`Stream`). */
export const KeepFoldHeader = createContext<((header: HTMLElement, top: number) => void) | null>(null);

/**
 * A collapsed section that renders its content only once opened: most of a long conversation
 * stays folded, and keeping it out of the DOM keeps showing and restyling the tab cheap.
 */
export function Fold({
  id,
  className,
  open,
  defaultOpen,
  summary,
  children,
}: {
  /** Remembers whether the reader opened it across remounts (`OpenFolds`). */
  id?: string;
  className?: string;
  open?: boolean;
  /** Starts open; the reader can still fold it. */
  defaultOpen?: boolean;
  summary: ReactElement;
  children: ReactNode;
}) {
  const always = useContext(FoldedContent);
  const remembered = useContext(OpenFolds);
  const keepHeader = useContext(KeepFoldHeader);
  const [expanded, setExpanded] = useState(() => !!open || !!defaultOpen || (!!id && !!remembered?.get(id)));
  const ref = useRef<HTMLDetailsElement>(null);
  const remember = (now: boolean) => {
    if (!id || !remembered) return;
    if (now) remembered.set(id, true);
    else remembered.delete(id);
  };
  return (
    <details
      ref={ref}
      className={className}
      open={open || ((!!id || defaultOpen) && expanded) || undefined}
      // Toggle here rather than natively: the content renders in the same frame, and the header
      // is put back where it was before anything paints.
      onClick={(e) => {
        const details = ref.current;
        const header = e.target instanceof Element ? e.target.closest("summary") : null;
        if (e.defaultPrevented || !details || !header || header.parentElement !== details) return;
        if ((e.target as Element).closest("a, button, input, select, textarea, label") !== null) return;
        e.preventDefault();
        const top = header.getBoundingClientRect().top;
        const now = !details.open;
        details.open = now;
        remember(now);
        flushSync(() => setExpanded(now));
        keepHeader?.(header, top);
      }}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        setExpanded(now);
        remember(now);
      }}
    >
      {summary}
      {(expanded || open || always) && children}
    </details>
  );
}
