/** React popups for LSP editor features, rendered as a workbench overlay. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import {
  Checkbox,
  Dialog,
  HighlightedText,
  Icon,
  IconButton,
  Input,
  List,
  MenuList,
  Popup,
  Select,
  SymbolBadge,
  fileIconName,
  fuzzyMatch,
  selectableText,
  T,
} from "@/ui";
import { basename, relativePath, useProject } from "@/platform/project";
import { editorService } from "@/workbench/contributions";
import {
  closePopup,
  updatePopup,
  useLspPopup,
  type ListPopupItem,
  type ListPreview,
  type LspPopup,
} from "./popupStore";
import { shortcutLabel } from "@/platform/keymap";
import {
  docLinkHandler,
  docStep,
  editDocSource,
  moveDocPopupToWindow,
  useDocWindow,
  type DocHistory,
  type DocHost,
} from "./docs";
import { renderCode, renderMarkup } from "./markdown";
import { describeSummary } from "./workspaceEdit";
import { useUsagesStatus } from "./navigation";
import styles from "./Popups.module.css";

export function BulbIcon({ fix }: { fix?: boolean }) {
  return <Icon name="bulb" size={16} className={clsx(styles.bulb, fix && styles.bulbFix)} />;
}

function ItemIcon({ item }: { item: ListPopupItem }) {
  if (item.symbol) return <SymbolBadge kind={item.symbol} />;
  if (item.icon === "bulb" || item.icon === "bulb-fix") return <BulbIcon fix={item.icon === "bulb-fix"} />;
  if (item.icon) return <Icon name={item.icon} size={14} className={styles.itemIcon} />;
  return <span className={styles.iconSpacer} />;
}

function ListPreviewPanel({ preview }: { preview: ListPreview | null | "loading" }) {
  if (preview === "loading") return <div className={styles.previewPanel} aria-busy="true" />;
  if (!preview) return null;
  return (
    <div className={styles.previewPanel} aria-label="Preview">
      {preview.kind === "text" ? (
        <div className={styles.previewText}>{preview.text}</div>
      ) : (
        <pre className={styles.diff}>
          {preview.lines.map((l, i) => (
            <div key={i} className={clsx(styles.diffLine, styles[`diff-${l.kind}`])}>
              {l.kind === "gap" ? "⋯" : l.text || " "}
            </div>
          ))}
          {preview.note && <div className={styles.previewText}>{preview.note}</div>}
        </pre>
      )}
    </div>
  );
}

function ListPopup({ popup }: { popup: Extract<LspPopup, { kind: "list" }> }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    if (!query) return popup.items.map((item) => ({ item, match: null as number[] | null }));
    return popup.items.map((item) => ({ item, match: fuzzyMatch(item.label, query) })).filter((r) => r.match !== null);
  }, [popup.items, query]);
  const firstEnabled = Math.max(
    0,
    filtered.findIndex((r) => !r.item.disabled),
  );
  const [active, setActive] = useState(firstEnabled);
  const activeIndex = Math.min(active, Math.max(0, filtered.length - 1));
  const activeItem = filtered[activeIndex]?.item;

  // Choosers highlight what the selected row would act on.
  useEffect(() => {
    activeItem?.onActive?.();
  }, [activeItem]);

  const [preview, setPreview] = useState<{ id: string; data: ListPreview | null } | null>(null);
  const fetchPreview = popup.preview;
  useEffect(() => {
    if (!fetchPreview || !activeItem || activeItem.disabled) return;
    const ctrl = new AbortController();
    // Moving quickly through the list must not queue a resolve per row.
    const timer = setTimeout(() => {
      fetchPreview(activeItem, ctrl.signal).then(
        (data) => !ctrl.signal.aborted && setPreview({ id: activeItem.id, data }),
        () => !ctrl.signal.aborted && setPreview({ id: activeItem.id, data: null }),
      );
    }, 120);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [activeItem, fetchPreview]);

  const activate = (item: ListPopupItem) => {
    if (item.disabled) return;
    closePopup();
    void item.run();
  };

  // IDEA's right-arrow menu of a row (inspection options of a fix).
  const bodyRef = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<{ item: ListPopupItem; anchor: Element } | null>(null);
  const openSub = (item: ListPopupItem, row?: Element | null) => {
    if (!item.submenu?.length || item.disabled || !bodyRef.current) return;
    const anchor = row ?? bodyRef.current.querySelector('[role="option"][aria-selected="true"]') ?? bodyRef.current;
    setSub({ item, anchor });
  };
  const closeSub = () => {
    setSub(null);
    bodyRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowRight" && activeItem?.submenu?.length) {
      e.preventDefault();
      openSub(activeItem);
    } else if (popup.numbered && !query && /^[1-9]$/.test(e.key)) {
      const item = popup.items[Number(e.key) - 1];
      e.preventDefault();
      if (item) activate(item);
    } else if (e.key === "Backspace" && query) {
      setQuery(query.slice(0, -1));
      setActive(0);
      e.preventDefault();
    } else if (e.key.length === 1 && !(e.key === " " && !query)) {
      setQuery(query + e.key);
      setActive(0);
      e.preventDefault();
    }
  };

  const height = Math.min(12, Math.max(1, filtered.length)) * 24;
  // Rows are virtualized (absolutely positioned), so size the popup from the content.
  const width = useMemo(() => {
    const chars = Math.max(
      popup.title.length + (popup.pin ? 4 : 0),
      ...popup.items.map(
        (i) => i.label.length + (i.preview?.length ?? 0) + (i.detail?.length ?? 0) + (i.shortcut?.length ?? 0),
      ),
    );
    return Math.min(720, Math.max(320, chars * 7 + 90 + (popup.numbered ? 16 : 0)));
  }, [popup]);
  const shownPreview = popup.preview
    ? preview && preview.id === activeItem?.id
      ? preview.data
      : activeItem && !activeItem.disabled
        ? ("loading" as const)
        : null
    : null;
  const indexOf = (item: ListPopupItem) => popup.items.indexOf(item);
  return (
    <Popup
      open
      anchor={popup.anchor}
      onClose={closePopup}
      aria-label={popup.title}
      className={clsx(styles.listPopup, popup.preview && styles.withPreview)}
      style={popup.preview ? undefined : { width }}
    >
      <div className={styles.listMain} style={popup.preview ? { width } : undefined}>
        <div className={styles.listHeader}>
          <span className={styles.listTitle}>{popup.title}</span>
          {query && <span className={styles.query}>{query}</span>}
          {popup.pin && (
            <IconButton
              icon="pin"
              size="small"
              title={popup.pin.label}
              onClick={() => {
                const run = popup.pin!.run;
                closePopup();
                run();
              }}
            />
          )}
        </div>
        <div ref={bodyRef} onKeyDown={onKeyDown} className={styles.listBody} style={{ height }}>
          <List
            items={filtered}
            getKey={(r) => r.item.id}
            activeIndex={activeIndex}
            onActiveChange={setActive}
            hoverSelects
            aria-label={popup.title}
            onActivate={(r) => activate(r.item)}
            empty={
              <span className={styles.empty}>
                <T>Nothing matches</T>
              </span>
            }
            renderItem={({ item, match }) => {
              const n = popup.numbered && !query ? indexOf(item) + 1 : 0;
              return (
                <div
                  className={clsx(styles.item, item.disabled && styles.disabled, item.emphasis && styles.emphasis)}
                  title={item.disabled ?? undefined}
                >
                  {popup.numbered && <span className={styles.mnemonic}>{n > 0 && n <= 9 ? n : ""}</span>}
                  <ItemIcon item={item} />
                  <HighlightedText className={styles.label} text={item.label} indices={match} tone="accent" />
                  {item.preview && <span className={styles.preview}>{item.preview}</span>}
                  <span className={styles.spacer} />
                  {item.detail && <span className={styles.detail}>{item.detail}</span>}
                  {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
                  {item.submenu?.length ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className={styles.subArrow}
                      aria-label={`${item.label} options`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        openSub(item, e.currentTarget.closest('[role="option"]'));
                      }}
                    >
                      <Icon name="chevron-right" size={14} />
                    </button>
                  ) : null}
                </div>
              );
            }}
          />
        </div>
      </div>
      {popup.preview && <ListPreviewPanel preview={shownPreview} />}
      {sub?.item.submenu && (
        <Popup
          open
          anchor={sub.anchor}
          placement="right-start"
          offset={2}
          role="presentation"
          autoFocus={false}
          onClose={closeSub}
          className={styles.subMenu}
        >
          <MenuList items={sub.item.submenu} aria-label={sub.item.label} onDone={closePopup} onCloseLevel={closeSub} />
        </Popup>
      )}
    </Popup>
  );
}

function RenamePopup({ popup }: { popup: Extract<LspPopup, { kind: "rename" }> }) {
  const [value, setValue] = useState(popup.initial);
  const ref = useRef<HTMLInputElement>(null);
  const suggestions = popup.suggestions ?? [];
  useEffect(() => {
    ref.current?.select();
  }, []);
  const submit = (name = value.trim()) => {
    closePopup();
    popup.onSubmit(name);
  };
  const pick = (delta: number) => {
    if (!suggestions.length) return false;
    const i = suggestions.indexOf(value.trim());
    const next = suggestions[(i + delta + suggestions.length) % suggestions.length]!;
    setValue(next);
    requestAnimationFrame(() => ref.current?.select());
    return true;
  };
  return (
    <Popup
      open
      anchor={popup.anchor}
      placement="bottom-start"
      onClose={closePopup}
      aria-label={popup.title}
      className={styles.renamePopup}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className={styles.renameLabel} htmlFor="lsp-rename-input">
          {popup.title}
        </label>
        <Input
          id="lsp-rename-input"
          ref={ref}
          mono
          data-autofocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && pick(e.key === "ArrowDown" ? 1 : -1))
              e.preventDefault();
          }}
          invalid={!value.trim()}
          aria-label="New name"
        />
        {suggestions.length > 1 && (
          <ul className={styles.renameSuggestions} aria-label="Suggested names">
            {suggestions.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  className={clsx(styles.renameSuggestion, s === value.trim() && styles.renameSuggestionActive)}
                  onClick={() => submit(s)}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        )}
        {popup.note && <div className={styles.renameNote}>{popup.note}</div>}
        <div className={styles.renameHint}>{popup.hint ?? "↵ Rename · Esc Cancel"}</div>
      </form>
    </Popup>
  );
}

function DomContent({ build, className }: { build: () => HTMLElement; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const node = build();
    el.replaceChildren(node);
    return () => el.replaceChildren();
    // Built once per popup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={ref} className={className} />;
}

/** Documentation with its history toolbar; shared by the popup and the Documentation tool window. */
function DocView({ host, history, themeClasses }: { host: DocHost; history: DocHistory; themeClasses: string }) {
  const entry = history.entries[history.index];
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      docStep(host, e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "F4" && entry?.source) {
      e.preventDefault();
      void editDocSource(host);
    }
  };
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-lsp-doc={host}
      className={clsx(themeClasses, host === "popup" ? styles.docFrame : styles.docWindowFrame)}
      onKeyDown={onKeyDown}
    >
      {entry && (
        <DomContent
          key={`${history.index}:${history.entries.length}`}
          className={clsx(styles.docBody, selectableText)}
          build={() => renderMarkup(entry.markup, entry.language, docLinkHandler(host))}
        />
      )}
      <div className={styles.docToolbar}>
        <IconButton
          icon="arrow-left"
          size="small"
          title="Back"
          shortcut="←"
          disabled={history.index === 0}
          onClick={() => docStep(host, -1)}
        />
        <IconButton
          icon="arrow-right"
          size="small"
          title="Forward"
          shortcut="→"
          disabled={history.index >= history.entries.length - 1}
          onClick={() => docStep(host, 1)}
        />
        <span className={styles.spacer} />
        {entry?.source && (
          <IconButton
            icon="edit"
            size="small"
            title="Edit Source"
            shortcut="F4"
            onClick={() => void editDocSource(host)}
          />
        )}
        {host === "popup" && (
          <IconButton
            icon="open-in-tool-window"
            size="small"
            title="Show in Documentation Tool Window"
            shortcut={shortcutLabel("code.quickDocumentation") || undefined}
            onClick={() => moveDocPopupToWindow()}
          />
        )}
      </div>
    </div>
  );
}

function DocPopup({ popup }: { popup: Extract<LspPopup, { kind: "doc" }> }) {
  const focusSeq = useLspPopup((s) => s.focusSeq);
  const scope = useRef<HTMLDivElement>(null);
  const opened = useRef(focusSeq);
  useEffect(() => {
    if (focusSeq !== opened.current)
      scope.current?.querySelector<HTMLElement>("[data-lsp-doc]")?.focus({ preventScroll: true });
  }, [focusSeq]);
  return (
    <Popup
      open
      anchor={popup.anchor}
      onClose={closePopup}
      aria-label="Documentation"
      className={styles.docPopup}
      // As in IDEA the popup leaves the keyboard to the editor until F1 focuses it.
      autoFocus={false}
    >
      <div ref={scope} className={styles.docScope}>
        <DocView host="popup" history={popup} themeClasses={popup.themeClasses} />
      </div>
    </Popup>
  );
}

/** The Documentation tool window (F1 on a focused documentation popup). */
export function DocumentationWindow() {
  const history = useDocWindow();
  if (!history.entries.length) {
    return (
      <div className={styles.docWindowEmpty}>
        <T>No documentation</T>
      </div>
    );
  }
  return <DocView host="window" history={history} themeClasses={history.themeClasses} />;
}

function DefinitionPopup({ popup }: { popup: Extract<LspPopup, { kind: "definition" }> }) {
  const root = useProject((s) => s.project?.root ?? "");
  const target = popup.targets[popup.index]!;
  const { location } = target;
  const many = popup.targets.length > 1;
  const open = () => {
    closePopup();
    void editorService().openFile(location.path, {
      selection: { line: location.range.start.line, col: location.range.start.col },
      focus: true,
    });
  };
  const select = (index: number) =>
    updatePopup("definition", { index: (index + popup.targets.length) % popup.targets.length });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (many && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      select(popup.index + (e.key === "ArrowLeft" ? -1 : 1));
    } else if (e.key === "F4") {
      e.preventDefault();
      open();
    }
  };
  return (
    <Popup open anchor={popup.anchor} onClose={closePopup} aria-label="Definition" className={styles.defPopup}>
      <div className={styles.defFrame} tabIndex={-1} data-autofocus onKeyDown={onKeyDown}>
        <div className={styles.defHeader}>
          <Icon name={fileIconName(basename(location.path))} size={14} />
          {many ? (
            <Select
              variant="ghost"
              aria-label="Definition"
              value={String(popup.index)}
              options={popup.targets.map((t, i) => ({
                value: String(i),
                label: t.name,
                detail: `${basename(t.location.path)}:${t.location.range.start.line + 1}`,
              }))}
              onChange={(v) => select(Number(v))}
            />
          ) : (
            <span className={styles.defFile}>{basename(location.path)}</span>
          )}
          <span className={styles.defPath}>
            {relativePath(root, location.path)}:{location.range.start.line + 1}
          </span>
          <span className={styles.spacer} />
          {many && (
            <span className={styles.defCount}>
              {popup.index + 1}/{popup.targets.length}
            </span>
          )}
          <IconButton icon="edit" size="small" title="Edit Source" shortcut="F4" onClick={open} />
        </div>
        <div className={clsx(popup.themeClasses, styles.docScope)}>
          <DomContent
            key={popup.index}
            className={clsx(styles.defBody, selectableText)}
            build={() => renderCode(target.text, target.language, "cm-lsp-code")}
          />
        </div>
      </div>
    </Popup>
  );
}

function PreviewDialog({ popup }: { popup: Extract<LspPopup, { kind: "preview" }> }) {
  const root = useProject((s) => s.project?.root ?? "");
  const { summary } = popup;
  return (
    <Dialog
      open
      onClose={closePopup}
      title={popup.title}
      width={560}
      buttons={[
        {
          label: popup.confirmLabel,
          role: "default",
          autoFocus: true,
          onClick: () => {
            closePopup();
            popup.onConfirm();
          },
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      {popup.warnings?.map((w) => (
        <div key={w} className={styles.previewWarning} role="note">
          <Icon name="warning" size={14} />
          <span>{w}</span>
        </div>
      ))}
      <div className={styles.previewSummary}>{describeSummary(summary)}</div>
      {popup.occurrences ? (
        <ul className={styles.previewList} aria-label="Occurrences">
          {popup.occurrences.map((o, i) => {
            const lead = o.text.length - o.text.trimStart().length;
            const text = o.text.trim();
            const from = Math.max(0, o.from - lead);
            const to = Math.max(from, Math.min(text.length, o.to - lead));
            return (
              <li key={i} className={styles.previewRow}>
                <span className={styles.previewLine}>{o.line + 1}</span>
                <span className={styles.previewCode}>
                  {text.slice(0, from)}
                  <mark className={styles.previewMatch}>{text.slice(from, to)}</mark>
                  {text.slice(to)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className={styles.previewList} aria-label="Changes">
          {summary.entries.map((e) => (
            <li key={e.path} className={styles.previewRow}>
              <Icon name={fileIconName(basename(e.path))} size={14} className={styles.itemIcon} />
              <span className={styles.previewName}>{basename(e.path)}</span>
              <span className={styles.previewPath}>{relativePath(root, e.path)}</span>
              <span className={styles.spacer} />
              {e.operation === "rename" && e.to && <span className={styles.previewOp}>→ {basename(e.to)}</span>}
              {e.operation && e.operation !== "rename" && <span className={styles.previewOp}>{e.operation}</span>}
              {e.edits > 0 && (
                <span className={styles.previewCount}>
                  {e.edits} {e.edits === 1 ? "occurrence" : "occurrences"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Reformat File… (⌥⇧⌘L): scope and options, then Reformat Code. */
function ReformatDialog({ popup }: { popup: Extract<LspPopup, { kind: "reformat" }> }) {
  const [selectionOnly, setSelectionOnly] = useState(popup.hasSelection && popup.initial.selectionOnly);
  const [optimizeImports, setOptimizeImports] = useState(popup.canOptimizeImports && popup.initial.optimizeImports);
  return (
    <Dialog
      open
      onClose={closePopup}
      title={popup.title}
      width={380}
      buttons={[
        {
          label: "Run",
          role: "default",
          autoFocus: true,
          onClick: () => {
            closePopup();
            popup.onRun({ selectionOnly, optimizeImports });
          },
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <fieldset className={styles.reformatGroup}>
        <legend className={styles.reformatLegend}>
          <T>Scope</T>
        </legend>
        <label className={styles.reformatOption}>
          <input type="radio" name="reformat-scope" checked={!selectionOnly} onChange={() => setSelectionOnly(false)} />
          <T>Whole file</T>
        </label>
        <label className={clsx(styles.reformatOption, !popup.hasSelection && styles.disabled)}>
          <input
            type="radio"
            name="reformat-scope"
            checked={selectionOnly}
            disabled={!popup.hasSelection}
            onChange={() => setSelectionOnly(true)}
          />
          <T>Selected text</T>
        </label>
      </fieldset>
      <fieldset className={styles.reformatGroup}>
        <legend className={styles.reformatLegend}>
          <T>Options</T>
        </legend>
        <Checkbox
          checked={optimizeImports}
          disabled={!popup.canOptimizeImports}
          onChange={setOptimizeImports}
          label="Optimize imports"
        />
      </fieldset>
    </Dialog>
  );
}

/** Status bar text while ⌘⇧F7 usages are highlighted ("3 usages of 'x' found…"). */
export function UsagesStatus() {
  const text = useUsagesStatus((s) => s.text);
  if (!text) return null;
  return (
    <span className={styles.statusMessage} role="status" title={text}>
      {text}
    </span>
  );
}

/** Overlay host: renders the current LSP popup, if any. */
export function LspPopups() {
  const popup = useLspPopup((s) => s.popup);
  const seq = useLspPopup((s) => s.seq);
  if (!popup) return null;
  switch (popup.kind) {
    case "list":
      return <ListPopup key={seq} popup={popup} />;
    case "rename":
      return <RenamePopup key={seq} popup={popup} />;
    case "doc":
      return <DocPopup key={seq} popup={popup} />;
    case "definition":
      return <DefinitionPopup key={seq} popup={popup} />;
    case "preview":
      return <PreviewDialog key={seq} popup={popup} />;
    case "reformat":
      return <ReformatDialog key={seq} popup={popup} />;
  }
}
