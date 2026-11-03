import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { NotebookCell } from "@/bindings";
import { tx } from "@/platform/i18n";
import { Button, Dialog, EmptyState, IconButton, Select, Spinner } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { CellEditor } from "./CellEditor";
import { CellOutputs, MarkdownCell } from "./OutputView";
import { notebookSession, type NotebookSession } from "./session";
import styles from "./Notebook.module.css";

export function NotebookEditor({ input }: { input: EditorInput }) {
  if (!input.path) return <EmptyState title="Notebook path is missing" />;
  return <NotebookDocument key={input.path} session={notebookSession(input.path)} />;
}

function NotebookDocument({ session }: { session: NotebookSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const root = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [selected, select] = useState<string | null>(session.selectedCell);
  const [reloadOpen, setReloadOpen] = useState(false);
  const cells = session.cells();
  const active = cells.find((cell) => cell.id === selected) ?? cells.find((cell) => cell.cellType === "code");
  const invoke = useCallback(
    (work: Promise<unknown>) => {
      void work.catch((error) => session.report(error));
    },
    [session],
  );
  const choose = (id: string) => {
    session.selectedCell = id;
    select(id);
  };
  const virtualizer = useVirtualizer({
    count: cells.length,
    getScrollElement: () => scroll.current,
    getItemKey: (index) => cells[index]!.id,
    estimateSize: () => 220,
    overscan: 3,
    initialOffset: session.scrollTop,
  });
  useEffect(() => {
    invoke(session.load());
  }, [session, invoke]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const history = (event: InputEvent) => {
      if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      invoke(event.inputType === "historyUndo" ? session.undo() : session.redo());
    };
    element.addEventListener("beforeinput", history, true);
    return () => element.removeEventListener("beforeinput", history, true);
  }, [session, invoke]);

  const disabled = state.frozen || !state.snapshot;
  const historyDisabled = disabled || state.running;
  const options = state.environments.map((sdk) => ({ value: sdk.path, label: sdk.name, detail: sdk.path }));
  if (state.python && !options.some((option) => option.value === state.python))
    options.unshift({
      value: state.python,
      label: state.python,
      detail: state.python,
    });
  return (
    <div
      ref={root}
      className={styles.root}
      tabIndex={-1}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey) {
          const key = event.key.toLowerCase();
          if (key === "s") {
            event.preventDefault();
            event.stopPropagation();
            invoke(session.save());
          }
          if (key === "z" || key === "y") {
            event.preventDefault();
            event.stopPropagation();
            invoke(event.shiftKey || key === "y" ? session.redo() : session.undo());
          }
        }
        if (event.key === "Enter" && (event.shiftKey || event.ctrlKey) && active?.cellType === "code") {
          event.preventDefault();
          event.stopPropagation();
          invoke(session.execute([active.id]));
        }
      }}
    >
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Notebook toolbar")}>
        <Button
          size="small"
          variant="primary"
          icon="run"
          disabled={disabled || state.running || active?.cellType !== "code"}
          onClick={() => active && invoke(session.execute([active.id]))}
        >
          Run Cell
        </Button>
        <Button
          size="small"
          icon="run"
          disabled={disabled || state.running || !cells.some((cell) => cell.cellType === "code")}
          onClick={() => invoke(session.execute())}
        >
          Run All
        </Button>
        <IconButton
          icon="stop"
          title="Interrupt Kernel"
          disabled={disabled || !state.running}
          onClick={() => invoke(session.interrupt())}
        />
        <IconButton
          icon="refresh"
          title="Restart Kernel"
          disabled={disabled}
          onClick={() => invoke(session.restart())}
        />
        <span className={styles.separator} />
        <Select
          className={styles.interpreter}
          aria-label={tx("Notebook Python interpreter")}
          placeholder="Select Python interpreter"
          value={state.python}
          options={options}
          disabled={disabled || state.running}
          onChange={(value) => session.selectPython(value)}
        />
        <IconButton
          icon="refresh"
          title="Refresh Python interpreters"
          disabled={disabled || state.running}
          onClick={() => invoke(session.detectEnvironments())}
        />
        <span className={styles.kernel} role="status" title={state.error ?? undefined}>
          {state.running && <Spinner size={12} />}
          {tx(state.running ? "busy" : state.kernel)}
        </span>
        <span className={styles.spacer} />
        <IconButton
          icon="undo"
          title="Undo"
          disabled={historyDisabled || (!state.snapshot?.canUndo && !state.pending)}
          onClick={() => invoke(session.undo())}
        />
        <IconButton
          icon="redo"
          title="Redo"
          disabled={historyDisabled || !state.snapshot?.canRedo}
          onClick={() => invoke(session.redo())}
        />
        <IconButton icon="save" title="Save" disabled={disabled} onClick={() => invoke(session.save())} />
        <IconButton
          icon="refresh"
          title="Reload Notebook from Disk"
          disabled={disabled}
          onClick={() => setReloadOpen(true)}
        />
      </div>
      {state.error && (
        <div role="alert" className={styles.error}>
          <div className={styles.errorMessage}>
            {state.error}
            {/ipykernel/i.test(state.error) && (
              <span className={styles.kernelHelp}>
                {tx(
                  "Install ipykernel in the selected Python environment, then restart the kernel. No packages are installed automatically.",
                )}
              </span>
            )}
            {state.pending > 0 && (
              <details>
                <summary>{tx("Uncommitted source edits")}</summary>
                {session.pendingSources().map(({ cell, source }) => (
                  <pre key={cell}>{source}</pre>
                ))}
              </details>
            )}
          </div>
          {state.pending > 0 && (
            <Button size="small" onClick={() => invoke(session.flush())}>
              Retry Pending Edits
            </Button>
          )}
          {!state.snapshot && (
            <Button size="small" onClick={() => invoke(session.load())}>
              Retry
            </Button>
          )}
        </div>
      )}
      {state.loading && !state.snapshot ? (
        <EmptyState title="Loading notebook…">
          <Spinner />
        </EmptyState>
      ) : !state.snapshot ? (
        <EmptyState title="Notebook unavailable">
          {tx("Notebook editing and execution require the desktop app.")}
        </EmptyState>
      ) : (
        <div
          ref={scroll}
          className={styles.scroll}
          onScroll={(event) => {
            session.scrollTop = event.currentTarget.scrollTop;
          }}
        >
          {cells.length === 0 ? (
            <EmptyState
              title="This notebook has no cells"
              actions={
                <Button
                  icon="add"
                  disabled={disabled}
                  onClick={() => session.edit({ type: "insertCell", after: null, cellType: "code" })}
                >
                  Add Code Cell
                </Button>
              }
            />
          ) : (
            <div className={styles.cellList} style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const cell = cells[item.index]!;
                return (
                  <div
                    key={cell.id}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    className={styles.virtualCell}
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <NotebookCellView
                      session={session}
                      cell={cell}
                      index={item.index}
                      cells={cells}
                      selected={active?.id === cell.id}
                      frozen={disabled}
                      running={state.running}
                      onSelect={() => choose(cell.id)}
                    />
                  </div>
                );
              })}
            </div>
          )}
          <div className={styles.addBar}>
            <Button
              size="small"
              icon="add"
              disabled={disabled || state.running}
              onClick={() => session.edit({ type: "insertCell", after: cells.at(-1)?.id ?? null, cellType: "code" })}
            >
              Add Code Cell
            </Button>
            <Button
              size="small"
              icon="add"
              disabled={disabled || state.running}
              onClick={() =>
                session.edit({ type: "insertCell", after: cells.at(-1)?.id ?? null, cellType: "markdown" })
              }
            >
              Add Markdown Cell
            </Button>
          </div>
        </div>
      )}
      <Dialog
        open={reloadOpen}
        onClose={() => setReloadOpen(false)}
        title={tx("Reload Notebook from Disk")}
        icon="warning"
        buttons={[
          { label: "Cancel", role: "cancel" },
          {
            label: "Discard Changes and Reload",
            role: "default",
            onClick: () => {
              setReloadOpen(false);
              invoke(session.discard().finally(() => session.cancelClose()));
            },
          },
        ]}
      >
        {tx("Discard all unsaved notebook changes and stop execution? This cannot be undone.")}
      </Dialog>
    </div>
  );
}

function NotebookCellView({
  session,
  cell,
  index,
  cells,
  selected,
  frozen,
  running,
  onSelect,
}: {
  session: NotebookSession;
  cell: NotebookCell;
  index: number;
  cells: NotebookCell[];
  selected: boolean;
  frozen: boolean;
  running: boolean;
  onSelect: () => void;
}) {
  const [editing, setEditing] = useState(session.markdownEditing.has(cell.id));
  const known = cell.cellType === "code" || cell.cellType === "markdown";
  const structuralDisabled = frozen || running;
  return (
    <section
      className={`${styles.cell} ${selected ? styles.selected : ""}`}
      onFocusCapture={onSelect}
      onClick={onSelect}
      aria-label={`${tx("Cell")} ${index + 1}: ${cell.cellType}`}
    >
      <div className={styles.cellToolbar}>
        <span className={styles.executionCount}>
          {cell.cellType === "code" ? `[${cell.executionCount ?? " "}]` : `${index + 1}`}
        </span>
        <Select
          aria-label={tx("Cell type")}
          variant="ghost"
          value={cell.cellType}
          disabled={structuralDisabled || (!known && cell.cellType !== "raw")}
          options={[
            { value: "code", label: "Code" },
            { value: "markdown", label: "Markdown" },
            { value: "raw", label: "Raw" },
            ...(!["code", "markdown", "raw"].includes(cell.cellType)
              ? [{ value: cell.cellType, label: cell.cellType }]
              : []),
          ]}
          onChange={(value) => session.edit({ type: "setCellType", cell: cell.id, cellType: value })}
        />
        {cell.cellType === "code" && (
          <IconButton
            icon="run"
            size="small"
            title="Run Cell"
            disabled={frozen || running}
            onClick={() => {
              void session.execute([cell.id]).catch((error) => session.report(error));
            }}
          />
        )}
        {cell.cellType === "markdown" && (
          <IconButton
            icon={editing ? "eye" : "edit"}
            size="small"
            title={editing ? "Preview Markdown" : "Edit Markdown"}
            disabled={frozen}
            onClick={() => {
              if (editing) session.markdownEditing.delete(cell.id);
              else session.markdownEditing.add(cell.id);
              setEditing(!editing);
            }}
          />
        )}
        <span className={styles.spacer} />
        <IconButton
          icon="arrow-up"
          size="small"
          title="Move Cell Up"
          disabled={structuralDisabled || index === 0}
          onClick={() => session.edit({ type: "moveCell", cell: cell.id, before: cells[index - 1]!.id })}
        />
        <IconButton
          icon="arrow-down"
          size="small"
          title="Move Cell Down"
          disabled={structuralDisabled || index === cells.length - 1}
          onClick={() => session.edit({ type: "moveCell", cell: cell.id, before: cells[index + 2]?.id ?? null })}
        />
        <IconButton
          icon="add"
          size="small"
          title="Insert Code Cell Below"
          disabled={structuralDisabled}
          onClick={() => session.edit({ type: "insertCell", after: cell.id, cellType: "code" })}
        />
        <IconButton
          icon="delete"
          size="small"
          title="Delete Cell"
          disabled={structuralDisabled}
          onClick={() => session.edit({ type: "deleteCell", cell: cell.id })}
        />
      </div>
      {!known ? (
        <div className={styles.rawCell}>
          <p className={styles.notice}>{tx("Raw or unknown cell; original content is preserved read-only.")}</p>
          <pre>{cell.source}</pre>
        </div>
      ) : cell.cellType === "markdown" && !editing ? (
        <div
          onDoubleClick={() => {
            if (!frozen) {
              session.markdownEditing.add(cell.id);
              setEditing(true);
            }
          }}
        >
          {cell.source ? (
            <MarkdownCell source={cell.source} attachments={cell.attachments} path={session.path} />
          ) : (
            <Button
              variant="ghost"
              disabled={frozen}
              onClick={() => {
                session.markdownEditing.add(cell.id);
                setEditing(true);
              }}
            >
              Edit Markdown
            </Button>
          )}
        </div>
      ) : (
        <CellEditor session={session} id={cell.id} source={cell.source} type={cell.cellType} frozen={frozen} />
      )}
      {cell.cellType === "code" && <CellOutputs outputs={cell.outputs} />}
    </section>
  );
}
