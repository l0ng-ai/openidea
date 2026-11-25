import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { RebaseAction } from "@/bindings";
import { tx } from "@/platform/i18n";
import { hasPrimaryModifier, macStroke, strokeOf } from "@/platform/keymap";
import {
  Button,
  Dialog,
  IconButton,
  listNavigate,
  rowSelectionMode,
  selectRow,
  selectedRows,
  Select,
  SINGLE_FIRST,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  T,
} from "@/ui";
import { registerUndoHandler } from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import { openDialog } from "./dialogs";
import { RebasePlanChanges } from "./RebasePlanChanges";
import {
  combineRebaseRows,
  fixupReplacementMessage,
  moveRebaseRows,
  rebaseRoots,
  rebaseRowKey,
  rebaseRowsMatch,
  setRebaseRowAction,
  type RebasePlanRow,
  type RebaseRow,
} from "./rebasePlan";
import styles from "./common.module.css";

const ACTIONS: Array<{ value: RebaseAction; label: string }> = [
  { value: "pick", label: "Pick" },
  { value: "reword", label: "Reword" },
  { value: "edit", label: "Stop to Edit" },
  { value: "squash", label: "Squash" },
  { value: "fixup", label: "Fixup" },
  { value: "drop", label: "Drop" },
];

const BATCH_ACTIONS = ACTIONS.filter(({ value }) => value !== "reword");
type RowAction = RebaseAction | "fixupReplace" | "fixupEdit";
const FIXUP_MESSAGE_ACTIONS: Array<{ value: RowAction; label: string }> = ACTIONS.flatMap((option) =>
  option.value === "fixup"
    ? [
        option,
        { value: "fixupReplace" as const, label: "Fixup (Replace)" },
        { value: "fixupEdit" as const, label: "Fixup (Edit)" },
      ]
    : [option],
);

function rowAction(row: RebaseRow): RowAction {
  if (row.fixupMessage === "replace") return "fixupReplace";
  if (row.fixupMessage === "edit") return "fixupEdit";
  return row.action;
}

function previewMessage(row: RebaseRow): string {
  if (row.action === "reword") return row.message.trimEnd() || row.commit.summary;
  if (row.fixupMessage) return fixupReplacementMessage(row.commit.message);
  return row.commit.message.trimEnd() || row.commit.summary;
}

type HistoryCommand = "undo" | "redo";
const textInput = "input, textarea, [contenteditable]";

export function useCloseRebasePlan(dirty: boolean, onClose: () => void): () => void {
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  return () => {
    if (!dirty) {
      onClose();
      return;
    }
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    void ask({
      title: "Cancel Rebase",
      body: <T>Discard changes and cancel rebase?</T>,
      cancel: false,
      signal: controller.signal,
      buttons: [
        { id: "discard", label: "Discard Changes", primary: true },
        { id: "cancel", label: "Continue Editing" },
      ],
    }).then(({ button }) => {
      pending.current = null;
      if (button === "discard") onClose();
    });
  };
}

export function RebasePlanDialog({
  repo,
  title,
  initial,
  validate,
  disableStart,
  replyProblem,
  onClose,
  onStart,
  onEditText,
}: {
  repo: string | null;
  title: string;
  initial: RebasePlanRow[];
  validate: (rows: readonly RebasePlanRow[]) => string | null;
  disableStart?: (rows: readonly RebasePlanRow[]) => boolean;
  replyProblem?: string | null;
  onClose: () => void;
  onStart: (rows: readonly RebasePlanRow[]) => void;
  onEditText?: (rows: readonly RebasePlanRow[]) => void;
}) {
  const [original] = useState(initial);
  const hasFixupMessages = original.some((row) => row.action === "fixup" && row.fixupMessage);
  const [history, setHistory] = useState(() => ({ snapshots: [initial], index: 0 }));
  const rows = history.snapshots[history.index]!;
  const [selection, setSelection] = useState(SINGLE_FIRST);
  const messageEdit = useRef<string | null>(null);
  const focusMessageFor = useRef<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const commitButtons = useRef(new Map<string, HTMLButtonElement>());
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const measure = () => setStacked(page.clientWidth < 640);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    return () => observer.disconnect();
  }, []);

  const selectable = rows.map((row) => ({ key: rebaseRowKey(row) }));
  const selectionKeys = new Set(selectedRows(selectable, selection).map(({ key }) => key));
  const selectedCommits = rows
    .filter((row) => row.action !== "updateRef")
    .filter((row) => selectionKeys.has(row.commit.id));
  const includesRef = selectedCommits.length < selectionKeys.size;
  const roots = rebaseRoots(rows);
  const movedUp = moveRebaseRows(rows, selectionKeys, -1);
  const movedDown = moveRebaseRows(rows, selectionKeys, 1);
  const selectedIndex = selection.lead;
  const selected = rows[selectedIndex];
  const problem = validate(rows);
  const dirty = !rebaseRowsMatch(rows, original);
  const closePlan = useCloseRebasePlan(dirty, onClose);
  const showHistory = (next: typeof history) => {
    const nextRows = next.snapshots[next.index]!;
    const indexOf = (index: number) => nextRows.findIndex((row) => rebaseRowKey(row) === selectable[index]?.key);
    setSelection((s) => ({ ...s, lead: indexOf(s.lead), anchor: indexOf(s.anchor) }));
    setHistory(next);
  };
  const editRows = (next: RebasePlanRow[], replace = false) => {
    if (rebaseRowsMatch(next, rows)) return;
    const end = history.index + (replace ? 0 : 1);
    showHistory({
      snapshots: [...history.snapshots.slice(Math.max(0, end - 49), end), next],
      index: Math.min(end, 49),
    });
  };
  const applyHistory = (command: HistoryCommand) => {
    const index = history.index + (command === "undo" ? -1 : 1);
    if (index >= 0 && index < history.snapshots.length) showHistory({ ...history, index });
  };
  const handleHistory = useEffectEvent((command: HistoryCommand, focused: Element) => {
    if (focused.closest(textInput) || !pageRef.current?.contains(focused)) return false;
    applyHistory(command);
    return true;
  });
  useEffect(() => registerUndoHandler((command, focused) => handleHistory(command, focused)), []);
  const onPlanKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing || (e.target as Element).closest(textInput)) return;
    const stroke = strokeOf(e.nativeEvent);
    const key = stroke && macStroke(stroke);
    if (key !== "Meta+Z" && key !== "Shift+Meta+Z") return;
    e.preventDefault();
    applyHistory(key === "Meta+Z" ? "undo" : "redo");
  };
  const onCommitKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (hasPrimaryModifier(e) && !e.altKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelection({ lead: index, anchor: index, keys: new Set(selectable.map(({ key }) => key)) });
      return;
    }
    const next = listNavigate(e.key, { items: rows, active: index });
    if (next === null) return;
    e.preventDefault();
    setSelection((s) => selectRow(selectable, s, next, rowSelectionMode(e)));
    commitButtons.current.get(selectable[next]!.key)?.focus();
  };
  const applyBatchAction = (action: RebaseAction) => {
    if (action === "squash" || action === "fixup") {
      const combined = combineRebaseRows(rows, selectionKeys, action);
      if (combined.messageCommit) {
        const lead = combined.rows.findIndex((row) => rebaseRowKey(row) === combined.messageCommit);
        focusMessageFor.current = combined.messageCommit;
        editRows(combined.rows);
        setSelection({ lead, anchor: lead, keys: new Set([...selectionKeys, combined.messageCommit]) });
      } else {
        editRows(combined.rows);
      }
    } else {
      editRows(setRebaseRowAction(rows, selectionKeys, action));
    }
  };
  const changesKey = selectedCommits
    .map((row) => row.commit.id)
    .sort()
    .join(" ");
  const changes = <RebasePlanChanges key={changesKey} repo={repo} selection={changesKey} />;
  const compactEditing = stacked && selected?.action === "reword";
  const details =
    selected?.action === "updateRef" ? (
      <section className={styles.rebaseDetails} aria-label={tx("Update Ref")}>
        <div className={styles.rebaseMetadata}>{selected.reference}</div>
        <div className={styles.rebasePreview}>
          <T>The ref will point to the commit at this position in the plan.</T>
        </div>
      </section>
    ) : (
      selected && (
        <section className={styles.rebaseDetails} aria-label={tx("Commit details")}>
          <div className={styles.rebaseMetadata}>
            <span className={styles.commitHash}>{selected.commit.shortId}</span>
            <span>{selected.commit.author}</span>
            {compactEditing && (
              <IconButton
                icon="file"
                size="small"
                title="Changed files"
                onClick={() =>
                  openDialog((close) => (
                    <Dialog
                      open
                      title={tx("Changed files")}
                      onClose={close}
                      width={520}
                      className={styles.rebaseDialog}
                      resizable="both"
                    >
                      {changes}
                    </Dialog>
                  ))
                }
              />
            )}
          </div>
          {selected.action === "reword" ? (
            <textarea
              key={selected.commit.id}
              ref={(box) => {
                if (box && focusMessageFor.current === selected.commit.id) {
                  focusMessageFor.current = null;
                  box.focus();
                }
              }}
              className={`${styles.textarea} ${styles.rebaseMessage}`}
              aria-label={tx`New message for ${selected.commit.shortId}`}
              rows={5}
              value={selected.message}
              onChange={(e) => {
                const message = e.currentTarget.value;
                const replace = messageEdit.current === selected.commit.id;
                messageEdit.current = selected.commit.id;
                editRows(
                  rows.map((row) => (row === selected ? { ...row, message } : row)),
                  replace,
                );
              }}
              onBlur={() => {
                messageEdit.current = null;
              }}
            />
          ) : (
            <div className={styles.rebasePreview}>{previewMessage(selected)}</div>
          )}
          {selected.action !== "reword" &&
            selectedCommits
              .filter((row) => row !== selected)
              .map((row) => (
                <div key={row.commit.id} className={styles.rebaseExtraCommit}>
                  <div className={styles.rebaseMetadata}>
                    <span className={styles.commitHash}>{row.commit.shortId}</span>
                    <span>{row.commit.author}</span>
                  </div>
                  <div className={styles.rebasePreview}>{previewMessage(row)}</div>
                </div>
              ))}
        </section>
      )
    );
  return (
    <Dialog
      open
      title={title}
      onClose={closePlan}
      width={960}
      minWidth={360}
      minHeight={360}
      resizable="both"
      className={styles.rebaseDialog}
      footerStart={
        onEditText && (
          <Button variant="ghost" onClick={() => onEditText(rows)}>
            Edit as Text
          </Button>
        )
      }
      buttons={[
        {
          label: "Start Rebasing",
          role: "default",
          disabled: !!problem || disableStart?.(rows),
          onClick: () => onStart(rows),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.rebasePage} ref={pageRef} onKeyDown={onPlanKey}>
        <SplitGroup id="rebase-panes" className={styles.rebaseSplit} orientation={stacked ? "vertical" : "horizontal"}>
          <SplitPanel id="rebase-plan" defaultSize="50%" minSize="30%">
            <div className={styles.rebaseToolbar}>
              <IconButton
                icon="arrow-up"
                size="small"
                title="Move Up"
                disabled={movedUp === rows}
                onClick={() => editRows(movedUp)}
              />
              <IconButton
                icon="arrow-down"
                size="small"
                title="Move Down"
                disabled={movedDown === rows}
                onClick={() => editRows(movedDown)}
              />
              <IconButton
                icon="undo"
                size="small"
                title="Undo"
                disabled={history.index === 0}
                onClick={() => applyHistory("undo")}
              />
              <IconButton
                icon="redo"
                size="small"
                title="Redo"
                disabled={history.index === history.snapshots.length - 1}
                onClick={() => applyHistory("redo")}
              />
              <Select<RebaseAction>
                value={null}
                options={BATCH_ACTIONS.map((option) => ({
                  ...option,
                  disabled: includesRef && (option.value === "squash" || option.value === "fixup"),
                }))}
                placeholder="Selected Commit Actions"
                disabled={selectionKeys.size < 2 || !selectedCommits.length}
                onChange={applyBatchAction}
              />
              <Button size="small" variant="ghost" disabled={!dirty} onClick={() => editRows(original)}>
                Reset
              </Button>
              <span className={styles.hint}>
                <T>Commits are applied from top to bottom.</T>
              </span>
            </div>
            <div
              className={styles.rebaseList}
              data-fixup-messages={hasFixupMessages || undefined}
              role="grid"
              aria-multiselectable
              aria-label={tx("Commits to rebase")}
            >
              {rows.map((r, i) => {
                const key = rebaseRowKey(r);
                const subject =
                  r.action === "updateRef"
                    ? r.reference.replace(/^refs\/heads\//, "")
                    : r.action === "reword"
                      ? r.message.trim().split(/\r?\n/, 1)[0] || r.commit.summary
                      : r.commit.summary;
                return (
                  <div
                    key={key}
                    className={styles.rebaseRow}
                    role="row"
                    aria-selected={selectionKeys.has(key)}
                    data-selected={selectionKeys.has(key) || undefined}
                    data-combined={roots.get(key) !== key || undefined}
                  >
                    <div role="gridcell" className={styles.rebaseCommitCell}>
                      <button
                        type="button"
                        className={styles.rebaseCommit}
                        tabIndex={i === selectedIndex ? 0 : -1}
                        data-autofocus={i === selectedIndex ? "" : undefined}
                        onClick={(e) => setSelection((s) => selectRow(selectable, s, i, rowSelectionMode(e)))}
                        onKeyDown={(e) => onCommitKey(e, i)}
                        ref={(button) => {
                          if (button) commitButtons.current.set(key, button);
                          else commitButtons.current.delete(key);
                        }}
                        title={subject}
                      >
                        <span className={styles.rebaseSubject} data-dropped={r.action === "drop" || undefined}>
                          {subject}
                        </span>
                        <span className={styles.commitHash}>
                          {r.action === "updateRef" ? r.reference : r.commit.shortId}
                        </span>
                      </button>
                    </div>
                    <div role="gridcell" className={styles.rebaseAction}>
                      {r.action === "updateRef" ? (
                        <span className={styles.rebaseRefAction}>
                          <T>Update Ref</T>
                        </span>
                      ) : (
                        <Select<RowAction>
                          value={rowAction(r)}
                          options={hasFixupMessages ? FIXUP_MESSAGE_ACTIONS : ACTIONS}
                          aria-label={tx`Action for ${r.commit.shortId}`}
                          onChange={(action) => {
                            focusMessageFor.current = action === "reword" ? r.commit.id : null;
                            const fixupMessage =
                              action === "fixupReplace" ? "replace" : action === "fixupEdit" ? "edit" : undefined;
                            const next = setRebaseRowAction(
                              rows,
                              new Set([r.commit.id]),
                              action === "fixupReplace" || action === "fixupEdit" ? "fixup" : action,
                              fixupMessage,
                            );
                            editRows(next);
                            const lead = next.findIndex((row) => rebaseRowKey(row) === key);
                            setSelection({ lead, anchor: lead, keys: null });
                          }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </SplitPanel>
          <SplitHandle aria-label={tx("Resize rebase panes")} />
          <SplitPanel id="rebase-details" defaultSize="50%" minSize="30%">
            {selected &&
              (compactEditing || !changesKey ? (
                details
              ) : (
                <SplitGroup id="rebase-commit-details" className={styles.rebaseDetailsSplit} orientation="vertical">
                  <SplitPanel id="rebase-files" defaultSize="54%" minSize="28%">
                    {changes}
                  </SplitPanel>
                  <SplitHandle />
                  <SplitPanel id="rebase-message" minSize="28%">
                    {details}
                  </SplitPanel>
                </SplitGroup>
              ))}
          </SplitPanel>
        </SplitGroup>
        {(replyProblem || problem) && (
          <div className={styles.error} role="alert">
            {replyProblem || tx(problem ?? "")}
          </div>
        )}
      </div>
    </Dialog>
  );
}
