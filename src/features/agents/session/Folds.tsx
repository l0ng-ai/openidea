import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

/** Set while Find in Conversation is open: folded sections render their content, so it is found. */
export const FoldedContent = createContext(false);

/**
 * Which keyed folds of a conversation the reader opened. A fold's row can remount (a run
 * grows from one call to two, a finished turn folds its work away); this keeps it as it was.
 */
export const OpenFolds = createContext<Map<string, boolean> | null>(null);

/** Scrolls a section the reader just opened into view (`Stream`). */
export const RevealFold = createContext<((el: HTMLElement) => void) | null>(null);

/**
 * A collapsed section that renders its content only once opened: most of a long conversation
 * stays folded, and keeping it out of the DOM keeps showing and restyling the tab cheap.
 */
export function Fold({
  id,
  className,
  open,
  summary,
  children,
}: {
  /** Remembers whether the reader opened it across remounts (`OpenFolds`). */
  id?: string;
  className?: string;
  open?: boolean;
  summary: ReactElement;
  children: ReactNode;
}) {
  const always = useContext(FoldedContent);
  const remembered = useContext(OpenFolds);
  const reveal = useContext(RevealFold);
  const [expanded, setExpanded] = useState(() => !!open || (!!id && !!remembered?.get(id)));
  const ref = useRef<HTMLDetailsElement>(null);
  const opened = useRef(false);
  // Once its content is laid out, so its height is known.
  useLayoutEffect(() => {
    if (!expanded || !opened.current) return;
    opened.current = false;
    if (ref.current) reveal?.(ref.current);
  }, [expanded, reveal]);
  return (
    <details
      ref={ref}
      className={className}
      open={open || (!!id && expanded) || undefined}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        opened.current = now;
        setExpanded(now);
        if (id && remembered) {
          if (now) remembered.set(id, true);
          else remembered.delete(id);
        }
      }}
    >
      {summary}
      {(expanded || open || always) && children}
    </details>
  );
}
