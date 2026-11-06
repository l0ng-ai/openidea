import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useTx } from "@/platform/i18n";
import { IconButton } from "./Button";
import { Toggle } from "./Checkbox";
import { copySelectionOnKeyDown } from "./selectableText";
import styles from "./LogPane.module.css";

export interface LogLine {
  stderr: boolean;
  text: string;
}

export interface LogToggle {
  id: string;
  label: string;
}

export interface LogPaneProps {
  /** Starts the source and returns its stop function; called again whenever the toggles or `sourceKey` change. */
  start(onLine: (l: LogLine) => void, onError: (message: string) => void, on: ReadonlySet<string>): () => void;
  sourceKey: string;
  toggles?: LogToggle[];
  /** "Waiting for output…" rather than "No output" while empty. */
  live: boolean;
  ariaLabel: string;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // eslint-disable-line no-control-regex
const MAX_LINES = 5000;

/** A followed log (container, program output) with toggles, Soft-wrap and Clear. */
export function LogPane({ sourceKey, ...props }: LogPaneProps) {
  const [on, setOn] = useState<ReadonlySet<string>>(() => new Set());
  const [wrap, setWrap] = useState(true);
  const onKey = [...on].sort().join("\0");
  // A new source (and buffer) per option set.
  return <LogStream key={`${sourceKey}\0${onKey}`} {...props} on={on} setOn={setOn} wrap={wrap} setWrap={setWrap} />;
}

function LogStream(
  props: Omit<LogPaneProps, "sourceKey"> & {
    on: ReadonlySet<string>;
    setOn: (on: ReadonlySet<string>) => void;
    wrap: boolean;
    setWrap: (wrap: boolean) => void;
  },
) {
  const tx = useTx();
  const { toggles = [], live, ariaLabel, on, setOn, wrap, setWrap } = props;
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const source = useRef({ start: props.start, on });

  useEffect(() => {
    let buffer: LogLine[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const add = buffer;
      buffer = [];
      setLines((prev) => {
        const next = prev.concat(add);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    const stop = source.current.start(
      (line) => {
        buffer.push({ stderr: line.stderr, text: line.text.replace(ANSI, "") });
        frame ||= requestAnimationFrame(flush);
      },
      setError,
      source.current.on,
    );
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(on);
    if (checked) next.add(id);
    else next.delete(id);
    setOn(next);
  };

  return (
    <div className={styles.pane}>
      <div className={styles.toolbar}>
        {toggles.map((t) => (
          <Toggle key={t.id} checked={on.has(t.id)} onChange={(checked) => toggle(t.id, checked)} label={t.label} />
        ))}
        <Toggle checked={wrap} onChange={setWrap} label="Soft-wrap" />
        <span className={styles.flex} />
        <IconButton icon="trash" size="small" title="Clear" onClick={() => setLines([])} />
      </div>
      <div
        ref={scroller}
        className={clsx(styles.log, wrap && styles.wrap)}
        tabIndex={0}
        role="log"
        onKeyDown={copySelectionOnKeyDown}
        aria-label={ariaLabel}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.map((l, i) => (
          <div key={i} className={clsx(l.stderr && styles.stderr)}>
            {l.text || " "}
          </div>
        ))}
        {error && <div className={styles.stderr}>{error}</div>}
        {!lines.length && !error && <div className={styles.dim}>{tx(live ? "Waiting for output…" : "No output")}</div>}
      </div>
    </div>
  );
}
