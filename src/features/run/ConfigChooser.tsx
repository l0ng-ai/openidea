import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import {
  HighlightedText,
  Icon,
  IconButton,
  List,
  Menu,
  Popup,
  SearchField,
  firstSelectable,
  fuzzyMatch,
  listNavigate,
  T,
  type MenuItem,
} from "@/ui";
import type { RunConfig } from "@/platform/ipc";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { useDebugRunSessions } from "@/workbench/contributions";
import { commandLine, configIcon, groupConfigs } from "./configs";
import { targetName } from "./remote";
import {
  canDeleteConfig,
  CURRENT_FILE,
  deleteConfig,
  MAX_RECENT,
  saveTemporary,
  selectConfig,
  startRun,
  toggleAllConfigurations,
  togglePinned,
  useRun,
} from "./store";
import { selectedTarget } from "./sessionTargets";
import styles from "./Run.module.css";
import { tx } from "@/platform/i18n";
import { confirm } from "@/workbench/messages";

type Row =
  /** A labelled group, or a thin separator when `label` is empty. */
  | { type: "section"; key: string; label: string }
  | { type: "config"; key: string; config: RunConfig; indices: number[] | null }
  | { type: "all"; key: string; count: number; expanded: boolean }
  | { type: "edit"; key: string }
  | { type: "current"; key: string; indices: number[] | null }
  | { type: "save"; key: string; config: RunConfig };

const ROW = 24;
const SEPARATOR = 9;
const CURRENT_FILE_LABEL = "Current File";

export function buildRows(
  configs: readonly RunConfig[],
  query: string,
  selected?: RunConfig | null,
  temporary: readonly string[] = [],
  pinned: readonly string[] = [],
  recent: readonly string[] = [],
  allExpanded = false,
): Row[] {
  const rows: Row[] = [];
  // IDEA: "Save '<name>' Configuration" first while a temporary configuration is selected.
  if (!query && selected && temporary.includes(selected.id)) rows.push({ type: "save", key: "save", config: selected });
  const matching = (list: readonly RunConfig[]) =>
    list.map((c) => ({ c, indices: query ? fuzzyMatch(c.name, query) : null })).filter((x) => !query || x.indices);
  const pushGroup = (label: string, key: string, list: readonly RunConfig[], prefix = "c") => {
    const matched = matching(list);
    if (matched.length === 0) return;
    rows.push({ type: "section", key, label });
    for (const { c, indices } of matched) rows.push({ type: "config", key: `${prefix}:${c.id}`, config: c, indices });
  };
  // IDEA: pinned configurations come first, in the order they were pinned.
  const pinnedConfigs = pinned.flatMap((id) => configs.find((c) => c.id === id) ?? []);
  pushGroup(tx("Pinned"), "s:pinned", pinnedConfigs);
  // Then the ones started last, newest first.
  const recentConfigs = recent.flatMap((id) => configs.find((c) => c.id === id && !pinned.includes(id)) ?? []);
  pushGroup(tx("Recent"), "s:recent", recentConfigs);
  const rest = configs.filter((c) => !pinnedConfigs.includes(c) && !recentConfigs.includes(c));
  // IDEA: once there are pinned or recent configurations, the others fold under "All Configurations"
  // (collapsed by default). Expanded, it lists every configuration by type; a search finds the folded ones.
  const folded = (pinnedConfigs.length > 0 || recentConfigs.length > 0) && configs.length >= MAX_RECENT;
  if (folded && !query) {
    rows.push({ type: "all", key: "all", count: configs.length, expanded: allExpanded });
    if (allExpanded)
      for (const group of groupConfigs(configs)) pushGroup(group.label, `a:${group.kind}`, group.configs, "a");
  } else {
    for (const group of groupConfigs(rest)) pushGroup(group.label, `s:${group.kind}`, group.configs);
  }
  // IDEA: the permanent "Current File" entry (runs the active file's context) follows the configurations.
  const currentIndices = query ? fuzzyMatch(CURRENT_FILE_LABEL, query) : null;
  if (!query || currentIndices) {
    if (rows.length) rows.push({ type: "section", key: "sep:current", label: "" });
    rows.push({ type: "current", key: "current", indices: currentIndices });
  }
  if (rows.length) rows.push({ type: "section", key: "sep:edit", label: "" });
  rows.push({ type: "edit", key: "edit" });
  return rows;
}

const rowHeight = (r: Row) => (r.type === "section" && !r.label ? SEPARATOR : ROW);

let closedAt = 0;
/** The chooser closed within the last moment (a click on its own anchor shouldn't reopen it). */
export function chooserJustClosed(): boolean {
  return Date.now() - closedAt < 250;
}

function anchorElement(): Element | { x: number; y: number } {
  return document.querySelector("[data-run-chooser]") ?? { x: Math.round(window.innerWidth / 2) - 150, y: 40 };
}

/** Run/Debug configuration chooser popup (⌃⌥R), anchored to the title bar widget. */
/** Deletes a configuration from the chooser once the user confirms, as IDEA's popup asks first. */
async function askDeleteConfig(config: RunConfig) {
  const ok = await confirm({
    title: "Confirmation",
    message: tx`Are you sure you want to delete ${config.name}?`,
    ok: "Delete",
  });
  if (ok) await deleteConfig(config.id);
}

export function ConfigChooserOverlay() {
  const open = useRun((s) => s.chooserOpen);
  if (!open) return null;
  return <ConfigChooser />;
}

/**
 * Numeric mnemonics (IDEA: 1–9 run the Nth configuration while the search is empty), for the
 * configurations above "All Configurations".
 */
export function mnemonics(rows: readonly Row[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.type === "all") break;
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
  const pinned = useRun((s) => s.pinned);
  const recent = useRun((s) => s.recent);
  const allExpanded = useRun((s) => s.allExpanded);
  const runTargets = useWorkflowSettings((s) => s.runTargets);
  const sessions = useRun((s) => s.sessions);
  const debugSessions = useDebugRunSessions((s) => s.sessions);
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () =>
      buildRows(
        configs,
        query,
        configs.find((c) => c.id === selectedId),
        temporary,
        pinned,
        recent,
        allExpanded,
      ),
    [configs, query, selectedId, temporary, pinned, recent, allExpanded],
  );
  const isSection = (r: Row) => r.type === "section";
  const [active, setActive] = useState(() =>
    rows.findIndex(
      (r) =>
        (r.type === "config" && r.config.id === selectedId) || (r.type === "current" && selectedId === CURRENT_FILE),
    ),
  );
  // The configuration whose actions menu (⋮) is open.
  const [menu, setMenu] = useState<{ name: string; anchor: Element; items: MenuItem[] } | null>(null);
  const [anchor] = useState(anchorElement);
  const close = () => {
    closedAt = Date.now();
    useRun.setState({ chooserOpen: false });
  };
  // Negative: the first row that can be selected (on opening without a visible selection, after a search).
  const clamped = active < 0 ? firstSelectable(rows, isSection) : Math.min(active, rows.length - 1);
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
    if (row.type === "all") {
      toggleAllConfigurations();
      return;
    }
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
        void executeAction(how === "run" ? "run.runContext" : "run.debugContext").then(() =>
          selectConfig(CURRENT_FILE),
        );
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
    const input = () => e.target as HTMLInputElement;
    if (e.key === "Enter") {
      e.preventDefault();
      // The widget (select mode) keeps Shift+Enter = Debug and Alt/⌘+Enter = Run.
      activate(row, mode !== "select" ? executor : e.shiftKey ? "debug" : e.altKey || e.metaKey ? "run" : "select");
      return;
    }
    // IDEA: → opens the configuration's actions, as its ⋮ button does.
    if (e.key === "ArrowRight" && row?.type === "config" && input().selectionStart === query.length) {
      const anchor = document.querySelector("[data-chooser-more]")?.closest("[role='option']");
      if (anchor) {
        e.preventDefault();
        openMenu(row.config, anchor);
        return;
      }
    }
    if (e.key === "F4" && row?.type === "config") {
      e.preventDefault();
      activate(row, "edit");
      return;
    }
    if (
      e.key === "Delete" &&
      row?.type === "config" &&
      canDeleteConfig(row.config.id) &&
      input().selectionStart === query.length &&
      input().selectionEnd === query.length
    ) {
      e.preventDefault();
      void askDeleteConfig(row.config);
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

  const height = Math.min(
    rows.reduce((sum, r) => sum + rowHeight(r), 0),
    14 * ROW,
  );

  // IDEA: a configuration's submenu lists its executors, then Edit and Pin.
  const menuItems = (c: RunConfig): MenuItem[] => {
    const row: Row = { type: "config", key: `c:${c.id}`, config: c, indices: null };
    return [
      { label: "Run", icon: "run", run: () => activate(row, "run") },
      { label: "Debug", icon: "debug", run: () => activate(row, "debug") },
      { kind: "header", label: "Configuration" },
      { label: "Edit…", icon: "edit", run: () => activate(row, "edit") },
      { label: pinned.includes(c.id) ? "Unpin" : "Pin", icon: "pin", run: () => togglePinned(c.id) },
      ...(canDeleteConfig(c.id) ? [{ label: "Delete", danger: true, run: () => void askDeleteConfig(c) }] : []),
    ];
  };
  const openMenu = (c: RunConfig, at: Element) => setMenu({ name: c.name, anchor: at, items: menuItems(c) });
  const more = (c: RunConfig) => (
    <IconButton
      icon="more"
      size="small"
      iconSize={13}
      title={tx("More Actions")}
      data-chooser-more=""
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation();
        // On the row, like IDEA's submenus: the button goes away when the pointer leaves the row.
        openMenu(c, e.currentTarget.closest("[role='option']") ?? e.currentTarget);
      }}
    />
  );

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
            setActive(-1);
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
          sectionHeightOf={(r) => (r.type === "section" && !r.label ? SEPARATOR : undefined)}
          renderSection={(r) =>
            r.type === "section" && r.label ? (
              <T>{r.label}</T>
            ) : (
              <span className={styles.chooserSeparator} role="separator" />
            )
          }
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
                  <span>{tx`Save '${r.config.name}' Configuration`}</span>
                </span>
              );
            }
            if (r.type === "current") {
              return (
                <span className={styles.chooserRow}>
                  <Icon name="file" size={13} className={styles.chooserIcon} />
                  <span className={clsx(styles.chooserName, selectedId === CURRENT_FILE && styles.chooserSelected)}>
                    {r.indices ? (
                      <HighlightedText text={CURRENT_FILE_LABEL} indices={r.indices} />
                    ) : (
                      <T>{CURRENT_FILE_LABEL}</T>
                    )}
                  </span>
                </span>
              );
            }
            if (r.type === "all") {
              return (
                <span className={clsx(styles.chooserRow, styles.chooserEdit)} aria-expanded={r.expanded}>
                  <Icon name={r.expanded ? "chevron-down" : "chevron-right"} size={13} />
                  <span className={styles.chooserName}>
                    <T>All Configurations</T>
                    <span className={styles.chooserCount}>{r.count}</span>
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
            const running = selectedTarget(c.id, sessions, debugSessions);
            return (
              <span className={styles.chooserRow} title={commandLine(c)}>
                <span className={clsx(styles.chooserIcon, running && styles.chooserRunning)}>
                  <Icon
                    name={configIcon(c)}
                    size={13}
                    className={clsx(temporary.includes(c.id) && styles.chooserTemporary)}
                  />
                </span>
                {numbers.size > 0 && <span className={styles.chooserMnemonic}>{numbers.get(r.key) ?? ""}</span>}
                <span className={clsx(styles.chooserName, c.id === selectedId && styles.chooserSelected)}>
                  {r.indices ? <HighlightedText text={c.name} indices={r.indices} /> : c.name}
                </span>
                {c.target && <span className={styles.chooserMuted}>@ {targetName(c, runTargets)}</span>}
                {c.isTest && (
                  <span className={styles.badge}>
                    <T>test</T>
                  </span>
                )}
                {!c.detected && (
                  <span className={styles.chooserMuted}>
                    <T>user</T>
                  </span>
                )}
                {temporary.includes(c.id) && (
                  <span className={styles.chooserMuted}>
                    <T>temporary</T>
                  </span>
                )}
                {isActive && running && (
                  <span className={styles.chooserActions}>
                    <IconButton
                      icon={running.debug ? "restart-debug-filled" : "rerun-filled"}
                      size="small"
                      iconSize={11}
                      title={tx`Rerun '${c.name}'`}
                      tabIndex={-1}
                      disabled={!running.rerun}
                      onClick={(e) => {
                        e.stopPropagation();
                        close();
                        running.rerun?.();
                      }}
                    />
                    <IconButton
                      icon="stop-filled"
                      size="small"
                      iconSize={11}
                      title={tx`Stop '${c.name}'`}
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        running.stop();
                      }}
                    />
                    {more(c)}
                  </span>
                )}
                {isActive && !running && (
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
                    {more(c)}
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
      {menu && (
        <Menu
          open
          anchor={menu.anchor}
          placement="right-start"
          items={menu.items}
          onClose={() => setMenu(null)}
          aria-label={tx`Actions for ${menu.name}`}
        />
      )}
    </Popup>
  );
}
