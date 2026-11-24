import { useTx } from "@/platform/i18n";
import { IconButton, SearchField } from "@/ui";
import { useEffect, useRef, useState, type RefObject } from "react";
import styles from "../Session.module.css";
import { findRanges, isFindRangeShown } from "../conversation";

interface RangeSet {
  clear(): void;
  add(range: Range): void;
}

function setHighlight(name: string, ranges: Range[]) {
  const highlights = (globalThis as { CSS?: { highlights?: Map<string, RangeSet> } }).CSS?.highlights;
  const HighlightCtor = (globalThis as { Highlight?: new () => RangeSet }).Highlight;
  if (!highlights || !HighlightCtor) return;
  let set = highlights.get(name);
  if (!set) {
    set = new HighlightCtor();
    highlights.set(name, set);
  }
  set.clear();
  for (const r of ranges) set.add(r);
}

/** Scrolls `range` into view in `stream`, opening the collapsed tool output or thought holding it. */
function revealRange(range: Range, stream: HTMLElement) {
  for (let el = range.startContainer.parentElement; el && el !== stream; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement) el.open = true;
  }
  const r = range.getBoundingClientRect();
  const box = stream.getBoundingClientRect();
  if (r.top < box.top + 24 || r.bottom > box.bottom - 24) {
    stream.scrollTop += r.top - box.top - box.height / 3;
  }
}

/** Find in Conversation: every match highlighted, Enter / ⇧Enter step through them. */
export function FindBar({
  streamRef,
  focus,
  onClose,
}: {
  streamRef: RefObject<HTMLDivElement | null>;
  focus: number;
  onClose: () => void;
}) {
  const tx = useTx();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focus]);

  // Matches follow the conversation as it streams in (and as code gets highlighted).
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRanges(findRanges(stream, query.trim())));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(stream, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [query, streamRef]);

  const index = ranges.length ? Math.min(current, ranges.length - 1) : -1;
  // Expanding or collapsing a tool output shows or hides its matches.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const stream = streamRef.current;
    const toggled = () => setShown((n) => n + 1);
    stream?.addEventListener("toggle", toggled, true);
    return () => stream?.removeEventListener("toggle", toggled, true);
  }, [streamRef]);
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    // Only rendered selectable matches outside closed <details>: WebKit paints unrendered
    // or user-select:none ranges in CSS.highlights over the next selectable row instead.
    const visible = (r: Range) => isFindRangeShown(r, stream);
    const current = index >= 0 ? ranges[index]! : null;
    setHighlight("agent-find", ranges.filter(visible));
    setHighlight("agent-find-current", current && visible(current) ? [current] : []);
  }, [ranges, index, shown, streamRef]);
  useEffect(
    () => () => {
      setHighlight("agent-find", []);
      setHighlight("agent-find-current", []);
    },
    [],
  );

  const step = (dir: 1 | -1) => {
    const stream = streamRef.current;
    if (!ranges.length || !stream) return;
    const next = (index + dir + ranges.length) % ranges.length;
    setCurrent(next);
    revealRange(ranges[next]!, stream);
  };
  const close = () => {
    onClose();
    streamRef.current?.focus();
  };

  return (
    <div className={styles.findBar} role="search">
      <SearchField
        ref={input}
        value={query}
        onChange={(v) => {
          setQuery(v);
          setCurrent(0);
        }}
        aria-label={tx("Find in Conversation")}
        placeholder={tx("Find in conversation")}
        className={styles.findField}
        trailing={
          query.trim() ? (
            <span className={styles.findCount}>
              {ranges.length ? `${index + 1}/${ranges.length}` : tx("0 results")}
            </span>
          ) : null
        }
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      <IconButton
        icon="arrow-up"
        title={tx("Previous Occurrence")}
        size="small"
        disabled={!ranges.length}
        onClick={() => step(-1)}
      />
      <IconButton
        icon="arrow-down"
        title={tx("Next Occurrence")}
        size="small"
        disabled={!ranges.length}
        onClick={() => step(1)}
      />
      <IconButton icon="close" title={tx("Close")} size="small" onClick={close} />
    </div>
  );
}
