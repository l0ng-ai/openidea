import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { EmptyState, IconButton, showContextMenu, T, type MenuItem } from "@/ui";
import { tx } from "@/platform/i18n";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { spanStyle } from "@/ui/ansi";
import ansi from "@/ui/ansi.module.css";
import { appendConsole, clearConsole, evaluate, isLive, useDebug, type DebugSession } from "../state";
import { pushHistory, readHistory, setConsoleHistoryBrowser } from "./expressionHistory";
import { useExpressionCompletion } from "./ExpressionCompletion";
import styles from "./DebugToolWindow.module.css";

export function DebugServiceConsole({ sessionId }: { sessionId: number }) {
  const session = useDebug((s) => s.sessions[sessionId]);
  return session ? (
    <DebugConsole key={sessionId} session={session} interactive={false} />
  ) : (
    <EmptyState title="No debug output available" />
  );
}

export function DebugConsole({ session, interactive = true }: { session: DebugSession; interactive?: boolean }) {
  const lines = useDebug((s) => s.console[session.id]);
  const scroller = useRef<HTMLDivElement>(null);
  // Scroll to End: follows new output; scrolling up turns it off, back to the end turns it on.
  const [follow, setFollow] = useState(true);
  const stick = useRef(true);
  stick.current = follow;
  // Settings › Console › Use soft wraps is the default; the toggle overrides it for this console.
  const defaultWrap = useWorkflowSettings((s) => s.console.softWrap);
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const softWrap = wrapOverride ?? defaultWrap;
  const programmatic = useRef(false);
  const [input, setInput] = useState("");
  const history = useRef<string[]>(readHistory("console"));
  const historyPos = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const completion = useExpressionCompletion(inputRef, input, setInput, session);

  const virtualizer = useVirtualizer({
    count: lines?.length ?? 0,
    getScrollElement: () => scroller.current,
    estimateSize: () => 18,
    overscan: 30,
    getItemKey: (i) => lines?.[i]?.id ?? i,
  });

  // Wrapping changes every row's height; the end is pinned again below.
  useLayoutEffect(() => virtualizer.measure?.(), [softWrap, virtualizer]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current || !lines?.length) return;
    programmatic.current = true;
    virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
    el.scrollTop = el.scrollHeight;
    // Rows measured after this frame grow the content: pin the end once more.
    requestAnimationFrame(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => (programmatic.current = false));
    });
  }, [lines, virtualizer, follow, softWrap]);

  const submit = async () => {
    const e = input.trim();
    if (!e) return;
    pushHistory("console", e);
    history.current = readHistory("console");
    historyPos.current = -1;
    setInput("");
    appendConsole(session.id, "input", `> ${e}\n`);
    try {
      const v = await evaluate(e, "repl", session);
      appendConsole(session.id, "result", `${v.value}\n`);
    } catch (err) {
      appendConsole(session.id, "stderr", `${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  /** IDEA's Browse History popup: the expressions typed before, most recent first. */
  const browseHistory = () => {
    const el = inputRef.current;
    const r = el?.getBoundingClientRect();
    const items: MenuItem[] = history.current.length
      ? history.current.slice(0, 30).map((h, i) => ({
          id: String(i),
          label: h.length > 120 ? `${h.slice(0, 120)}…` : h,
          run: () => {
            setInput(h);
            historyPos.current = i;
            el?.focus();
          },
        }))
      : [{ id: "none", label: "No history", disabled: true }];
    showContextMenu({ x: r?.left ?? 120, y: (r?.top ?? 200) - 4 }, items);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (completion.onKeyDown(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const h = history.current;
      if (!h.length) return;
      e.preventDefault();
      const pos = Math.max(-1, Math.min(h.length - 1, historyPos.current + (e.key === "ArrowUp" ? 1 : -1)));
      historyPos.current = pos;
      setInput(pos < 0 ? "" : h[pos]!);
    }
  };

  return (
    <div className={styles.console}>
      <div
        ref={scroller}
        className={clsx(styles.consoleOutput, ansi.palette, !softWrap && styles.noWrap)}
        onScroll={(e) => {
          if (programmatic.current) return;
          const el = e.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atEnd !== stick.current) setFollow(atEnd);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          showContextMenu(e, [{ label: "Clear All", icon: "trash", run: () => clearConsole(session.id) }]);
        }}
        role="log"
        onKeyDown={copySelectionOnKeyDown}
        aria-label={tx("Debug console")}
        tabIndex={0}
      >
        {!lines?.length && session.launch?.request === "attach" && (
          <T>The attached process may not provide standard output to the debugger.</T>
        )}
        <div className={styles.consoleInner} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const l = lines?.[item.index];
            if (!l) return null;
            return (
              <span
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={clsx(styles.out, styles[`cat-${l.category}`])}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {l.spans.map((sp, i) => (
                  <span key={i} style={spanStyle(sp)}>
                    {sp.text}
                  </span>
                ))}
              </span>
            );
          })}
        </div>
      </div>
      <div className={styles.repl}>
        {interactive && (
          <>
            <span className={styles.prompt} aria-hidden>
              ›
            </span>
            <input
              ref={inputRef}
              className={styles.evalInput}
              onFocus={() => setConsoleHistoryBrowser(browseHistory)}
              onBlur={() => {
                setConsoleHistoryBrowser(null);
                completion.close();
              }}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                completion.onInput();
              }}
              onKeyDown={onKeyDown}
              placeholder={isLive(session) ? "Evaluate in the debug console" : "Session finished"}
              disabled={!isLive(session)}
              aria-label={tx("Debug console input")}
              spellCheck={false}
              autoComplete="off"
            />
            {completion.popup}
          </>
        )}
        <IconButton
          icon="arrow-down"
          title="Scroll to End"
          size="small"
          iconSize={12}
          pressed={follow}
          onClick={() => setFollow((v) => !v)}
        />
        <IconButton
          icon="soft-wrap"
          title="Soft-Wrap"
          size="small"
          iconSize={12}
          pressed={softWrap}
          onClick={() => setWrapOverride(!softWrap)}
        />
        <IconButton
          icon="trash"
          title="Clear Console"
          size="small"
          iconSize={12}
          onClick={() => clearConsole(session.id)}
        />
      </div>
    </div>
  );
}
