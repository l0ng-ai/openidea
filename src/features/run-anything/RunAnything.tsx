/**
 * The Run Anything popup: a command line with the recent commands and the
 * providers' entries (run configurations, `mvn` / `gradle` goals…). Enter runs
 * the selected entry, or the line itself: a provider that claims it, else the
 * shell in the project directory, its output in the Run tool window.
 */
import { useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { Icon, Input, List, Popup, T, listNavigate } from "@/ui";
import { runAnythingProviderList } from "@/workbench/contributions";
import { buildRows, clearHistory, pushHistory, readHistory, shellRunConfig, type Row } from "./model";
import styles from "./RunAnything.module.css";

export const useRunAnything = create<{ open: boolean }>(() => ({ open: false }));

export const showRunAnything = () => useRunAnything.setState({ open: true });
const close = () => useRunAnything.setState({ open: false });

/** Runs a command line: a provider that claims it, else the platform shell. */
export async function runCommandLine(line: string): Promise<void> {
  const text = line.trim();
  const root = useProject.getState().project?.root;
  if (!text || !root) return;
  pushHistory(root, text);
  for (const p of runAnythingProviderList()) {
    try {
      if (p.execute && (await p.execute(text))) return;
    } catch (e) {
      console.error(`run anything provider ${p.id} failed`, e);
    }
  }
  await executeAction("run.runConfig", shellRunConfig(text, root, usePlatform.getState().os === "windows"));
}

export function RunAnythingHost() {
  const open = useRunAnything((s) => s.open);
  const root = useProject((s) => s.project?.root);
  if (!open || !root) return null;
  return <RunAnythingPopup root={root} />;
}

const isSection = (r: Row) => r.kind === "section";

function RunAnythingPopup({ root }: { root: string }) {
  const [line, setLine] = useState("");
  const [active, setActive] = useState(-1);
  const [history, setHistory] = useState(() => readHistory(root));
  const rows = useMemo(
    () =>
      buildRows(line.trim(), history, runAnythingProviderList(), (h) => {
        close();
        void runCommandLine(h);
      }),
    [line, history],
  );

  const run = (row: Row | undefined) => {
    if (!row || row.kind !== "item") return;
    close();
    if (row.group !== "recent") pushHistory(root, row.item.completion ?? row.item.label);
    void row.item.run();
  };
  const runLine = () => {
    if (!line.trim()) return;
    close();
    void runCommandLine(line);
  };
  const complete = (row: Row | undefined) => {
    if (!row || row.kind !== "item") return;
    setLine(row.item.completion ?? row.item.label);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key)) {
      const next = listNavigate(e.key, { items: rows, active: Math.max(active, 0), wrap: true, isSection });
      if (next !== null) {
        e.preventDefault();
        setActive(active < 0 && e.key === "ArrowDown" ? rows.findIndex((r) => !isSection(r)) : next);
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      complete(rows[active >= 0 ? active : rows.findIndex((r) => !isSection(r))]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) run(rows[active]);
      else runLine();
    }
  };

  return (
    <Popup
      open
      anchor={{ x: window.innerWidth / 2, y: 72 }}
      placement="bottom"
      onClose={close}
      role="dialog"
      aria-label="Run Anything"
      className={styles.popup}
      trapFocus
    >
      <div className={styles.body}>
        <div className={styles.header}>
          <span className={styles.title}>
            <T>Run Anything</T>
          </span>
          {history.length > 0 && (
            <button
              type="button"
              className={styles.link}
              onClick={() => {
                clearHistory(root);
                setHistory([]);
              }}
            >
              <T>Clear History</T>
            </button>
          )}
        </div>
        <div className={styles.inputRow}>
          <Icon name="run-anything" size={16} className={styles.inputIcon} />
          <Input
            data-autofocus
            variant="bare"
            className={styles.input}
            value={line}
            placeholder="Run a command, configuration or goal"
            aria-label="Command line"
            onChange={(e) => {
              setLine(e.target.value);
              setActive(-1);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <List
          items={rows}
          getKey={(r) => r.key}
          isSection={isSection}
          renderSection={(r) => <div className={styles.section}>{r.kind === "section" && <T>{r.label}</T>}</div>}
          activeIndex={active}
          onActiveChange={setActive}
          onActivate={(r) => run(r)}
          focusable={false}
          hoverSelects={false}
          className={styles.rows}
          aria-label="Run Anything entries"
          empty={
            <div className={styles.empty}>
              {line.trim() ? <T>Press Enter to run the command in the project directory</T> : <T>Type a command</T>}
            </div>
          }
          renderItem={(r, state) =>
            r.kind === "item" ? (
              <div className={clsx(styles.row, state.active && styles.activeRow)}>
                <Icon name={r.item.icon ?? "run"} size={16} className={styles.rowIcon} />
                <span className={styles.label}>{r.item.label}</span>
                {r.item.detail && <span className={styles.detail}>{r.item.detail}</span>}
              </div>
            ) : null
          }
        />
        <div className={styles.footer}>
          <T>Enter to run, Tab to complete. Other commands run in the project directory.</T>
        </div>
      </div>
    </Popup>
  );
}
