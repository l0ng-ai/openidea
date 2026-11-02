import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { IconButton, showContextMenu, T, type MenuItem } from "@/ui";
import { tx } from "@/platform/i18n";
import { spanStyle } from "@/ui/ansi";
import ansi from "@/ui/ansi.module.css";
import type { ConsoleControls } from "@/features/run/RunView";
import { appendConsole, clearConsole, evaluate, isLive, useDebug, type DebugSession } from "../state";
import { pushHistory, readHistory, setConsoleHistoryBrowser } from "./expressionHistory";
import styles from "./DebugToolWindow.module.css";

export function DebugConsole({
  session,
  interactive = true,
  strip = true,
  onControls,
}: {
  session: DebugSession;
  interactive?: boolean;
  /** Render the right-edge control strip here (the Services pane keeps a permanent one instead). */
  strip?: boolean;
  onControls?: (controls: ConsoleControls | null) => void;
}) {
  const lines = useDebug((s) => s.console[session.id]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const programmatic = useRef(false);
  const [input, setInput] = useState("");
  const history = useRef<string[]>(readHistory("console"));
  const historyPos = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const virtualizer = useVirtualizer({
    count: lines?.length ?? 0,
    getScrollElement: () => scroller.current,
    estimateSize: () => 18,
    overscan: 30,
    getItemKey: (i) => lines?.[i]?.id ?? i,
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current || !lines?.length) return;
    programmatic.current = true;
    virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => (programmatic.current = false));
  }, [lines, virtualizer]);

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

  // The console strip's buttons: page scrolling and jump to the live tail.
  const controls = useMemo<ConsoleControls>(
    () => ({
      scrollByPage: (dir) => {
        const el = scroller.current;
        if (el) el.scrollBy({ top: dir * el.clientHeight * 0.8 });
      },
      scrollToEnd: () => {
        const el = scroller.current;
        if (!el) return;
        stick.current = true;
        el.scrollTop = el.scrollHeight;
      },
      clear: () => clearConsole(session.id),
    }),
    [session.id],
  );
  useEffect(() => {
    if (strip) return;
    onControls?.(controls);
    return () => onControls?.(null);
  }, [strip, controls, onControls]);
  const scrollByPage = (dir: 1 | -1) => controls.scrollByPage(dir);
  const scrollToEnd = () => controls.scrollToEnd();

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
      <div className={styles.consoleMain}>
        <div
          ref={scroller}
          className={clsx(styles.consoleOutput, ansi.palette)}
          onScroll={(e) => {
            if (programmatic.current) return;
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
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
                onBlur={() => setConsoleHistoryBrowser(null)}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={isLive(session) ? tx("Evaluate in the debug console") : tx("Session finished")}
                disabled={!isLive(session)}
                aria-label={tx("Debug console input")}
                spellCheck={false}
                autoComplete="off"
              />
            </>
          )}
        </div>
      </div>
      {/* IDEA's console controls: a narrow strip on the console's right edge. */}
      {strip && (
        <div className={styles.consoleStrip}>
          <IconButton icon="chevron-up" iconSize={14} title="Scroll Up" onClick={() => scrollByPage(-1)} />
          <IconButton icon="chevron-down" iconSize={14} title="Scroll Down" onClick={() => scrollByPage(1)} />
          <IconButton icon="arrow-down" iconSize={14} title="Scroll to End" onClick={scrollToEnd} />
          <IconButton icon="trash" iconSize={14} title="Clear All" onClick={() => clearConsole(session.id)} />
        </div>
      )}
    </div>
  );
}
