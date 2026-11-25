/**
 * The Run Anything popup: a command line with the recent commands and the
 * providers' entries (run configurations, `mvn` / `gradle` goals…). Enter runs
 * the selected entry, or the line itself: a provider that claims it, else the
 * shell in the project directory, its output in the Run tool window.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { Icon, Kbd, List, Popup, SearchField, T, firstSelectable, listNavigate } from "@/ui";
import { runAnythingProviderList } from "@/workbench/contributions";
import { useRowHeight } from "@/ui/density";
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
const ROW_HEIGHT = 24;
const commandAnchor = { getBoundingClientRect: () => new DOMRect(window.innerWidth / 2, 72, 0, 0) };

function RunAnythingPopup({ root }: { root: string }) {
  const field = useRef<HTMLInputElement>(null);
  const rowHeight = useRowHeight(ROW_HEIGHT);
  const listId = useId();
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
  const selected = rows[active];
  const first = firstSelectable(rows, isSection);
  const hasRows = first >= 0;
  const command = selected?.kind === "item" ? (selected.item.completion ?? selected.item.label) : line;

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

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key)) {
      const height = e.currentTarget.ownerDocument.getElementById(listId)?.clientHeight ?? rowHeight;
      const pageSize = Math.max(1, Math.floor(height / rowHeight) - 1);
      const next = listNavigate(e.key, { items: rows, active, wrap: true, isSection, pageSize });
      if (next !== null && hasRows) {
        e.preventDefault();
        setActive(next < 0 ? first : next);
      }
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && hasRows) {
      e.preventDefault();
      e.stopPropagation();
      complete(selected ?? rows[first]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selected) run(selected);
      else runLine();
    }
  };

  return (
    <Popup
      open
      anchor={commandAnchor}
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
                setActive(-1);
                field.current?.focus();
              }}
            >
              <T>Clear History</T>
            </button>
          )}
        </div>
        <div className={styles.query}>
          <SearchField
            ref={field}
            data-autofocus
            leadingIcon="run-anything"
            variant="bare"
            className={styles.commandField}
            clearable={false}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={hasRows}
            aria-controls={hasRows ? listId : undefined}
            aria-activedescendant={selected?.kind === "item" ? `${listId}-${active}` : undefined}
            value={command}
            placeholder="Run a command, configuration or goal"
            aria-label="Command line"
            onChange={(value) => {
              setLine(value);
              setActive(-1);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {hasRows ? (
          <>
            <List
              id={listId}
              items={rows}
              getKey={(r) => r.key}
              isSection={isSection}
              renderSection={(r) => <div className={styles.section}>{r.kind === "section" && <T>{r.label}</T>}</div>}
              activeIndex={active}
              onActiveChange={setActive}
              onActivate={(r) => run(r)}
              focusable={false}
              hoverSelects={false}
              rowHeight={rowHeight}
              className={styles.rows}
              aria-label="Run Anything entries"
              renderItem={(r, state) =>
                r.kind === "item" ? (
                  <div className={clsx(styles.row, state.active && styles.activeRow)}>
                    <Icon name={r.item.icon ?? "run"} size={16} className={styles.rowIcon} />
                    <span className={styles.label} title={r.item.label}>
                      {r.item.label}
                    </span>
                    {r.item.detail && (
                      <span className={styles.detail} title={r.item.detail}>
                        {r.item.detail}
                      </span>
                    )}
                  </div>
                ) : null
              }
            />
            <div className={styles.footer}>
              <span className={styles.navigationHint}>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                <T>Navigate</T>
              </span>
              <T>Tab to complete, Enter to run</T>
            </div>
          </>
        ) : (
          line.trim() && (
            <div className={styles.empty}>
              <T>Press Enter to run the command in the project directory</T>
            </div>
          )
        )}
      </div>
    </Popup>
  );
}
