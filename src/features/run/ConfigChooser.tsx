import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { HighlightedText, Icon, IconButton, List, Popup, SearchField, fuzzyMatch, listNavigate, T } from "@/ui";
import type { RunConfig } from "@/platform/ipc";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { commandLine, configIcon, groupConfigs } from "./configs";
import { targetName } from "./remote";
import { canDeleteConfig, CURRENT_FILE, deleteConfig, saveTemporary, selectConfig, startRun, useRun } from "./store";
import styles from "./Run.module.css";
import { tx } from "@/platform/i18n";

type Row =
  | { type: "section"; key: string; label: string }
  | { type: "config"; key: string; config: RunConfig; indices: number[] | null }
  | { type: "edit"; key: string }
  | { type: "current"; key: string; indices: number[] | null }
  | { type: "save"; key: string; config: RunConfig };

const ROW = 24;
const CURRENT_FILE_LABEL = "Current File";

export function buildRows(
  configs: readonly RunConfig[],
  query: string,
  selected?: RunConfig | null,
  temporary: readonly string[] = [],
): Row[] {
  const rows: Row[] = [];
  // IDEA: "Save '<name>' Configuration" first while a temporary configuration is selected.
  if (!query && selected && temporary.includes(selected.id)) rows.push({ type: "save", key: "save", config: selected });
  // IDEA: the permanent "Current File" entry runs the active file's context.
  const currentIndices = query ? fuzzyMatch(CURRENT_FILE_LABEL, query) : null;
  if (!query || currentIndices) rows.push({ type: "current", key: "current", indices: currentIndices });
  for (const group of groupConfigs(configs)) {
    const matched = group.configs
      .map((c) => ({ c, indices: query ? fuzzyMatch(c.name, query) : null }))
      .filter((x) => !query || x.indices);
    if (matched.length === 0) continue;
    rows.push({ type: "section", key: `s:${group.kind}`, label: group.label });
    for (const { c, indices } of matched) rows.push({ type: "config", key: `c:${c.id}`, config: c, indices });
  }
  rows.push({ type: "edit", key: "edit" });
  return rows;
}

let closedAt = 0;
/** The chooser closed within the last moment (a click on its own anchor shouldn't reopen it). */
export function chooserJustClosed(): boolean {
  return Date.now() - closedAt < 250;
}

function anchorElement(): Element | { x: number; y: number } {
  return document.querySelector("[data-run-chooser]") ?? { x: Math.round(window.innerWidth / 2) - 150, y: 40 };
}

/** Run/Debug configuration chooser popup (⌃⌥R), anchored to the title bar widget. */
export function ConfigChooserOverlay() {
  const open = useRun((s) => s.chooserOpen);
  if (!open) return null;
  return <ConfigChooser />;
}

/** Numeric mnemonics (IDEA: 1–9 run the Nth configuration while the search is empty). */
export function mnemonics(rows: readonly Row[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.type !== "config") continue;
    if (out.size >= 9) break;
    out.set(r.key, out.size + 1);
  }
  return out;
}

function ConfigChooser() {
  const mode = useRun((s) => s.chooserMode);
  const configs = useRun((s) => s.configs);
  const selectedId = useRun((s) => s.selectedId);
  const temporary = useRun((s) => s.temporary);
  const runTargets = useWorkflowSettings((s) => s.runTargets);
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () =>
      buildRows(
        configs,
        query,
        configs.find((c) => c.id === selectedId),
        temporary,
      ),
    [configs, query, selectedId, temporary],
  );
  const isSection = (r: Row) => r.type === "section";
  const initial = Math.max(
    0,
    rows.findIndex(
      (r) => (r.type === "config" && r.config.id === selectedId) || (r.type === "current" && selectedId === CURRENT_FILE),
    ),
  );
  const [active, setActive] = useState(initial);
  const [anchor] = useState(anchorElement);
  const close = () => {
    closedAt = Date.now();
    useRun.setState({ chooserOpen: false });
  };
  const clamped = Math.min(active, rows.length - 1);
  const numbers = useMemo(
    () => (mode === "select" || query ? new Map<string, number>() : mnemonics(rows)),
    [mode, query, rows],
  );
  // IDEA: holding Shift switches to the alternative executor (Run ⇄ Debug) and updates the caption.
  const [shift, setShift] = useState(false);
  useEffect(() => {
    const track = (e: globalThis.KeyboardEvent) => setShift(e.shiftKey);
    const reset = () => setShift(false);
    window.addEventListener("keydown", track, true);
    window.addEventListener("keyup", track, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", track, true);
      window.removeEventListener("keyup", track, true);
      window.removeEventListener("blur", reset);
    };
  }, []);
  const executor = mode === "select" ? "select" : shift ? (mode === "run" ? "debug" : "run") : mode;

  const activate = (row: Row | undefined, how: "select" | "run" | "debug" | "edit" = executor) => {
    if (!row) return;
    close();
    if (row.type === "edit") {
      void executeAction("run.editConfigs");
      return;
    }
    if (row.type === "save") {
      void saveTemporary(row.config.id);
      return;
    }
    if (row.type === "current") {
      selectConfig(CURRENT_FILE);
      if (how === "run" || how === "debug")
        void executeAction(how === "run" ? "run.runContext" : "run.debugContext").then(() => selectConfig(CURRENT_FILE));
      return;
    }
    if (row.type !== "config") return;
    selectConfig(row.config.id);
    if (how === "edit") void executeAction("run.editConfigs", row.config.id);
    if (how === "run") void startRun(row.config);
    if (how === "debug") void executeAction("run.debug");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const row = rows[clamped];
    if (e.key === "Enter") {
      e.preventDefault();
      // The widget (select mode) keeps Shift+Enter = Debug and Alt/⌘+Enter = Run.
      activate(row, mode !== "select" ? executor : e.shiftKey ? "debug" : e.altKey || e.metaKey ? "run" : "select");
      return;
    }
    if (e.key === "F4" && row?.type === "config") {
      e.preventDefault();
      activate(row, "edit");
      return;
    }
    const input = e.target as HTMLInputElement;
    if (
      e.key === "Delete" &&
      row?.type === "config" &&
      canDeleteConfig(row.config.id) &&
      input.selectionStart === query.length
    ) {
      e.preventDefault();
      void deleteConfig(row.config.id);
      return;
    }
    if (numbers.size && !e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$|^Numpad[1-9]$/.test(e.code)) {
      const n = Number(e.code.slice(-1));
      const target = rows.find((r) => numbers.get(r.key) === n);
      if (target) {
        e.preventDefault();
        activate(target, e.shiftKey ? (mode === "run" ? "debug" : "run") : mode);
        return;
      }
    }
    const next = listNavigate(e.key, { items: rows, active: clamped, isSection, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  const height = Math.min(rows.length * ROW, 14 * ROW);

  return (
    <Popup
      open
      anchor={anchor}
      onClose={close}
      placement="bottom-start"
      aria-label="Run/Debug Configurations"
      className={styles.chooser}
      trapFocus
    >
      {mode !== "select" && (
        <div className={styles.chooserCaption}>
          <T>{executor === "debug" ? "Debug" : "Run"}</T>
        </div>
      )}
      <div className={styles.chooserSearch}>
        <SearchField
          value={query}
          onChange={(v) => {
            setQuery(v);
            setActive(1);
          }}
          placeholder="Search configurations"
          aria-label="Search configurations"
          data-autofocus=""
          onKeyDown={onKeyDown}
          variant="bare"
        />
      </div>
      <div style={{ height }}>
        <List<Row>
          aria-label="Configurations"
          className={styles.chooserList}
          items={rows}
          getKey={(r) => r.key}
          isSection={isSection}
          renderSection={(r) => (r.type === "section" ? r.label : null)}
          activeIndex={clamped}
          onActiveChange={setActive}
          focusable={false}
          hoverSelects
          rowHeight={ROW}
          onActivate={(r) => activate(r)}
          renderItem={(r, { active: isActive }) => {
            if (r.type === "save") {
              return (
                <span className={clsx(styles.chooserRow, styles.chooserEdit)}>
                  <Icon name="check" size={13} />
                  <span>Save &apos;{r.config.name}&apos; Configuration</span>
                </span>
              );
            }
            if (r.type === "current") {
              return (
                <span className={styles.chooserRow}>
                  <Icon name="file" size={13} className={styles.chooserIcon} />
                  <span className={clsx(styles.chooserName, selectedId === CURRENT_FILE && styles.chooserSelected)}>
                    {r.indices ? <HighlightedText text={CURRENT_FILE_LABEL} indices={r.indices} /> : <T>{CURRENT_FILE_LABEL}</T>}
                  </span>
                </span>
              );
            }
            if (r.type === "edit") {
              return (
                <span className={clsx(styles.chooserRow, styles.chooserEdit)}>
                  <Icon name="edit" size={13} />
                  <span>
                    <T>Edit Configurations…</T>
                  </span>
                  <span className={styles.chooserShortcut}>{shortcutLabel("run.editConfigs")}</span>
                </span>
              );
            }
            if (r.type !== "config") return null;
            const c = r.config;
            return (
              <span className={styles.chooserRow} title={commandLine(c)}>
                <Icon
                  name={configIcon(c)}
                  size={13}
                  className={clsx(styles.chooserIcon, temporary.includes(c.id) && styles.chooserTemporary)}
                />
                {numbers.size > 0 && <span className={styles.chooserMnemonic}>{numbers.get(r.key) ?? ""}</span>}
                <span className={clsx(styles.chooserName, c.id === selectedId && styles.chooserSelected)}>
                  {r.indices ? <HighlightedText text={c.name} indices={r.indices} /> : c.name}
                </span>
                {c.target && <span className={styles.chooserMuted}>@ {targetName(c, runTargets)}</span>}
                {c.isTest && <span className={styles.badge}>test</span>}
                {!c.detected && <span className={styles.chooserMuted}>user</span>}
                {temporary.includes(c.id) && <span className={styles.chooserMuted}>temporary</span>}
                {isActive && (
                  <span className={styles.chooserActions}>
                    <IconButton
                      icon="run"
                      size="small"
                      iconSize={11}
                      title={tx`Run '${c.name}'`}
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        activate(r, "run");
                      }}
                    />
                    <IconButton
                      icon="debug"
                      size="small"
                      iconSize={13}
                      title={tx`Debug '${c.name}'`}
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        activate(r, "debug");
                      }}
                    />
                  </span>
                )}
              </span>
            );
          }}
        />
      </div>
      {mode !== "select" && (
        <div className={styles.chooserHint}>
          <T>
            {mode === "run"
              ? "Hold Shift to Debug, F4 to edit, Delete to remove"
              : "Hold Shift to Run, F4 to edit, Delete to remove"}
          </T>
        </div>
      )}
    </Popup>
  );
}
