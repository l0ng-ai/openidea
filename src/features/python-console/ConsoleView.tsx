/** Python Console tool window: output, the input box below it, and the console's variables beside them. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { executeAction } from "@/platform/actions";
import { useConsoleFont } from "@/platform/consoleFont";
import { useTx } from "@/platform/i18n";
import { Button, EmptyState, IconButton, SplitGroup, SplitHandle, SplitPanel, T } from "@/ui";
import { spanStyle } from "@/ui/ansi";
import { clearOutput, execute, restartConsole, sendInput, startConsole, stopConsole, useConsole } from "./store";
import styles from "./PythonConsole.module.css";

export function ConsoleView() {
  const { status, header, output, variables, noInterpreter } = useConsole();
  const font = useConsoleFont();
  const t = useTx();
  const outputRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useEffect(() => void startConsole(), []);
  useLayoutEffect(() => {
    const el = outputRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  if (noInterpreter && status === "stopped") {
    return (
      <EmptyState
        title="No Python interpreter"
        actions={
          <>
            <Button onClick={() => void executeAction("python.interpreterSettings")}>
              <T>Interpreter Settings…</T>
            </Button>
            <Button onClick={() => void startConsole()}>
              <T>Retry</T>
            </Button>
          </>
        }
      >
        <T>Select an interpreter for this project to use the Python Console.</T>
      </EmptyState>
    );
  }

  const fontStyle = { fontFamily: font.family, fontSize: font.size, lineHeight: `${font.rowHeight}px` };
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <IconButton icon="rerun" title="Restart Console" size="small" onClick={restartConsole} />
        <IconButton
          icon="stop"
          title="Stop Console"
          size="small"
          disabled={status === "stopped"}
          onClick={stopConsole}
        />
        <IconButton icon="trash" title="Clear" size="small" onClick={clearOutput} />
        <span className={styles.header}>{header ?? (status === "starting" ? <T>Starting…</T> : null)}</span>
      </div>
      <SplitGroup orientation="horizontal" id="python-console-split" storageKey="openidea.pythonConsole.split">
        <SplitPanel id="console" minSize={200} className={styles.main}>
          <div
            ref={outputRef}
            className={styles.output}
            style={fontStyle}
            role="log"
            aria-label={t("Python Console output")}
            tabIndex={0}
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
            }}
          >
            {output.map((s, i) => (
              <span key={i} style={spanStyle(s)}>
                {s.text}
              </span>
            ))}
          </div>
          <ConsoleInput style={fontStyle} busy={status === "busy"} />
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="variables" minSize={140} defaultSize="30%" className={styles.variables}>
          {variables.length ? (
            <div role="list" aria-label={t("Console variables")} className={styles.varList}>
              {variables.map((v) => (
                <div role="listitem" key={v.name} className={styles.varRow} title={v.value}>
                  <span className={styles.varName}>{v.name}</span>
                  <span className={styles.varType}>{v.type}</span>
                  <span className={styles.varValue}>{v.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No variables" />
          )}
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}

/** Enter runs the input (or, while code runs, answers its `input()`); Shift+Enter adds a line; ↑/↓ recall. */
function ConsoleInput({ style, busy }: { style: React.CSSProperties; busy: boolean }) {
  const [text, setText] = useState("");
  const browse = useRef<number | null>(null);
  const t = useTx();
  return (
    <textarea
      className={styles.input}
      style={style}
      rows={Math.min(8, text.split("\n").length)}
      value={text}
      spellCheck={false}
      aria-label={t(busy ? "Input for the running code" : "Python Console input")}
      placeholder={busy ? t("Input for the running code") : ">>>"}
      onChange={(e) => {
        browse.current = null;
        setText(e.target.value);
      }}
      onKeyDown={(e) => {
        const el = e.currentTarget;
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (busy) sendInput(text);
          else execute(text);
          browse.current = null;
          setText("");
          return;
        }
        const { history } = useConsole.getState();
        const up = e.key === "ArrowUp" && !el.value.slice(0, el.selectionStart).includes("\n");
        const down = e.key === "ArrowDown" && !el.value.slice(el.selectionEnd).includes("\n");
        if ((!up && !down) || !history.length || busy) return;
        e.preventDefault();
        const at = browse.current ?? history.length;
        const next = Math.max(0, Math.min(history.length, at + (up ? -1 : 1)));
        browse.current = next;
        setText(history[next] ?? "");
      }}
    />
  );
}
