/**
 * Settings › Python › All Interpreters (PyCharm's "All interpreters"): every
 * interpreter the IDE knows — detected ones, the ones other recent projects use and
 * the ones added here — with add / remove, a search field, and PyCharm's two toolbar
 * toggles (hide interpreters of other projects, show interpreter paths).
 *
 * The project interpreter itself is chosen on the Python Interpreter page (or in the
 * status bar); a row's context menu switches it too.
 */
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { confirm } from "@/workbench/messages";
import { Icon } from "@/ui/icons";
import { IconButton, Input, Spinner, T, showContextMenu } from "@/ui";
import { useSetting } from "../components/context";
import { useSettingsDialog } from "../model/staging";
import { AddInterpreterDialog } from "./AddInterpreterDialog";
import { tildify } from "./components";
import {
  filterInterpreters,
  interpreterIcon,
  projectName,
  sameInterpreterPath,
  usePythonInterpreters,
  type InterpreterRow,
} from "./interpreters";
import styles from "./Sdk.module.css";

export function PythonInterpretersPage() {
  const root = useProject((s) => s.project?.root ?? null);
  // "Settings for New Projects" edits the global layer: it must not choose this project's interpreter.
  const newProjects = useSettingsDialog((s) => s.newProjects);
  const canAssign = !!root && !newProjects;
  const { rows, loading, refresh, projects } = usePythonInterpreters();
  const [added, setAdded] = useSetting<string[]>("languages.python.interpreters");
  const [hidden, setHidden] = useSetting<string[]>("languages.python.hiddenInterpreters");
  const [hideOther, setHideOther] = useSetting<boolean>("languages.python.hideOtherProjectInterpreters");
  const [showPaths, setShowPaths] = useSetting<boolean>("languages.python.showInterpreterPaths");
  const [interpreter, setInterpreter] = useSetting<string>("languages.python.interpreter", "project");
  const current = interpreter || null;

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const shown = useMemo(
    () => filterInterpreters(rows, { query, hideOther: !!hideOther, currentProject: root }),
    [rows, query, hideOther, root],
  );
  const selectedRow = shown.find((row) => row.path === selected) ?? null;

  const isCurrent = (row: InterpreterRow) => sameInterpreterPath(row.path, current ?? "", root);
  const belongsElsewhere = (row: InterpreterRow) =>
    !!row.project && !!root && !sameInterpreterPath(row.project, root, null);

  const selectForProject = (row: InterpreterRow) => {
    if (!canAssign || row.invalid || isCurrent(row)) return;
    setInterpreter(row.path);
  };

  const remove = async (row: InterpreterRow) => {
    const used = isCurrent(row);
    const ok = await confirm({
      title: "Remove Interpreter",
      message: used
        ? tx`Remove ${row.name} from the list? It is the project interpreter: the project falls back to its virtualenv.`
        : tx`Remove ${row.name} from the list? Its files are not deleted.`,
      ok: "Remove",
      icon: "warning",
    });
    if (!ok) return;
    const same = (path: string) => sameInterpreterPath(path, row.path, null);
    setHidden([...(hidden ?? []).filter((path) => !same(path)), row.path]);
    setAdded((added ?? []).filter((path) => !same(path)));
    if (used && canAssign) setInterpreter("");
    setSelected(null);
  };

  const menu = (e: MouseEvent, row: InterpreterRow) => {
    showContextMenu(e, [
      {
        label: "Set as Project Interpreter",
        icon: "check",
        disabled: !canAssign || row.invalid || isCurrent(row),
        run: () => selectForProject(row),
      },
      { kind: "separator" },
      { label: "Remove Interpreter", icon: "minus", danger: true, run: () => void remove(row) },
    ]);
  };

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : -1;
    if (next >= 0 && next < shown.length) {
      e.preventDefault();
      setSelected(shown[next]!.path);
      (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
    } else if ((e.key === "Delete" || e.key === "Backspace") && shown[i]) {
      e.preventDefault();
      void remove(shown[i]!);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.tablePanel}>
        <div className={styles.tableToolbar} role="toolbar" aria-label={tx("Interpreters")}>
          <IconButton
            icon="plus"
            size="small"
            title="Add Interpreter…"
            disabled={!canAssign}
            onClick={() => setAdding(true)}
          />
          <IconButton
            icon="minus"
            size="small"
            title="Remove Interpreter"
            disabled={!selectedRow}
            onClick={() => selectedRow && void remove(selectedRow)}
          />
          <IconButton icon="refresh" size="small" title="Refresh Interpreters" onClick={refresh} />
          <span className={styles.spacer} />
          <IconButton
            icon="filter"
            size="small"
            title="Hide Interpreters from Other Projects"
            pressed={!!hideOther}
            onClick={() => setHideOther(!hideOther)}
          />
          <IconButton
            icon="list"
            size="small"
            title="Show Interpreter Paths"
            pressed={!!showPaths}
            onClick={() => setShowPaths(!showPaths)}
          />
          <Input
            className={styles.search}
            value={query}
            placeholder="Search interpreters"
            aria-label="Search interpreters"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className={styles.tableScroll} role="listbox" aria-label={tx("Interpreters")}>
          {shown.map((row, i) => (
            <div
              key={row.path}
              role="option"
              aria-selected={selected === row.path}
              tabIndex={selected === row.path || (!selected && i === 0) ? 0 : -1}
              className={clsx(
                styles.interpretersRow,
                showPaths && styles.interpretersRowWithPath,
                selected === row.path && styles.selected,
              )}
              onMouseDown={() => setSelected(row.path)}
              onDoubleClick={() => selectForProject(row)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelected(row.path);
                menu(e, row);
              }}
              onKeyDown={(e) => onRowKey(e, i)}
            >
              <Icon name={interpreterIcon(row.source)} size={16} />
              <span className={styles.interpretersText}>
                <span className={styles.interpretersName}>{row.name}</span>
                {showPaths && (
                  <span className={styles.interpretersPath} title={row.path}>
                    {tildify(row.path)}
                  </span>
                )}
              </span>
              {belongsElsewhere(row) && (
                <span className={styles.badge} title={row.project ?? undefined}>
                  {projectName(row.project!, projects)}
                </span>
              )}
              {isCurrent(row) && (
                <span className={styles.badge}>
                  <T>Project interpreter</T>
                </span>
              )}
              {row.invalid && (
                <span className={styles.interpretersInvalid}>
                  <T>Invalid</T>
                </span>
              )}
            </div>
          ))}
          {shown.length === 0 && (
            <div className={styles.empty}>
              {loading ? (
                <Spinner size={14} label="Detecting interpreters" />
              ) : query ? (
                <T>No interpreters match the search</T>
              ) : (
                <T>No interpreters found. Add one with +.</T>
              )}
            </div>
          )}
        </div>
      </div>
      <div className={styles.note}>
        <T>Interpreters added here are shared by every project; removing one only hides it from this list.</T>{" "}
        {canAssign && <T>Double-click an interpreter to use it for this project.</T>}
      </div>

      {adding && canAssign && root && (
        <AddInterpreterDialog
          root={root}
          onClose={() => setAdding(false)}
          onAdded={(path) => {
            setAdding(false);
            const same = (candidate: string) => sameInterpreterPath(candidate, path, null);
            setHidden((hidden ?? []).filter((candidate) => !same(candidate)));
            setAdded([...(added ?? []).filter((candidate) => !same(candidate)), path]);
            setSelected(path);
            setInterpreter(path);
          }}
        />
      )}
    </div>
  );
}
