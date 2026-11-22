/** React popups for LSP editor features, rendered as a workbench overlay. */
import { openCodeLocation } from "@/editor/api";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
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
  Radio,
  Select,
  Spinner,
  SymbolBadge,
  fileIconName,
  firstSelectable,
  fuzzyMatch,
  selectableText,
  T,
} from "@/ui";
import { basename, relativeDir, relativePath, useProject } from "@/platform/project";
import {
  closePopup,
  updatePopup,
  useLspPopup,
  type DefinitionTarget,
  type ListPopupItem,
  type ListPreview,
  type LspPopup,
} from "./popupStore";
import { DOC_MIN_HEIGHT, DOC_MIN_WIDTH, loadDocSize, saveDocSize, useDocWindow } from "./docs";
import { DocView, DomContent } from "./DocView";
import { renderCode } from "./markdown";
import { describeSummary } from "./workspaceEdit";
import { useUsagesStatus } from "./navigation";
import styles from "./Popups.module.css";
import fieldsetStyles from "@/ui/DialogFieldset.module.css";
import { tx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";
import { useRowHeight } from "@/ui/density";

export function BulbIcon({ fix }: { fix?: boolean }) {
  return <Icon name={fix ? "bulb-fix" : "bulb"} size={16} className={styles.bulb} />;
}

function ItemIcon({ item }: { item: ListPopupItem }) {
  if (item.symbol) return <SymbolBadge kind={item.symbol} />;
  if (item.icon === "bulb" || item.icon === "bulb-fix") return <BulbIcon fix={item.icon === "bulb-fix"} />;
  if (item.icon) return <Icon name={item.icon} size={14} className={styles.itemIcon} />;
  return <span className={styles.iconSpacer} />;
}

function ListPreviewPanel({
  preview,
  themeClasses,
}: {
  preview: ListPreview | null | "loading";
  themeClasses?: string;
}) {
  if (preview === "loading") return <div className={styles.previewPanel} aria-busy="true" />;
  if (!preview) return null;
  return (
    <div className={clsx(styles.previewPanel, themeClasses)} role="region" aria-label={tx("Preview")}>
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

const LIST_PREVIEW_WIDTH = 420;
const MIN_SIDE_BY_SIDE_WIDTH = 660;

type ListPopupRow =
  | { kind: "action"; item: ListPopupItem; match: number[] | null }
  | { kind: "section"; key: string; label?: string };

const isListSection = (row: ListPopupRow) => row.kind === "section";
const dividerHeight = (row: ListPopupRow) => (row.kind === "section" && !row.label ? 9 : undefined);

function listPopupRows(items: ListPopupItem[], query: string): ListPopupRow[] {
  const rows: ListPopupRow[] = [];
  let previous: string | undefined;
  for (const item of items) {
    const match = query ? fuzzyMatch(item.label, query) : null;
    if (query && match === null) continue;
    const { section } = item;
    if (section?.id !== previous && (section?.label || rows.length)) {
      rows.push({ kind: "section", key: `section:${rows.length}`, label: section?.label });
    }
    rows.push({ kind: "action", item, match });
    previous = section?.id;
  }
  return rows;
}

function ListPopup({ popup }: { popup: Extract<LspPopup, { kind: "list" }> }) {
  const copyPath = popup.layout === "copyPath";
  const [query, setQuery] = useState("");
  const rows = useMemo(() => listPopupRows(popup.items, query), [popup.items, query]);
  const firstEnabled = rows.findIndex((row) => row.kind === "action" && !row.item.disabled);
  const [activeId, setActiveId] = useState<string | null>(null);
  const selected = rows.findIndex((row) => row.kind === "action" && row.item.id === activeId);
  const activeIndex =
    selected >= 0 ? selected : firstEnabled >= 0 ? firstEnabled : firstSelectable(rows, isListSection);
  const activeRow = rows[activeIndex];
  const activeItem = activeRow?.kind === "action" ? activeRow.item : undefined;
  const showIcons = !popup.compact || popup.items.some((item) => item.icon || item.symbol);
  const hasTargets = popup.items.some((item) => item.target);

  // Choosers highlight what the selected row would act on.
  useEffect(() => activeItem?.onActive?.(), [activeItem]);

  const [preview, setPreview] = useState<{ id: string; data: ListPreview | null } | null>(null);
  const fetchPreview = popup.preview;
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    if (!fetchPreview) return;
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [fetchPreview]);
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
      setActiveId(null);
      e.preventDefault();
    } else if (e.key.length === 1 && !(e.key === " " && !query)) {
      setQuery(query + e.key);
      setActiveId(null);
      e.preventDefault();
    }
  };

  const rowHeight = useRowHeight();
  const height = Math.min(
    12 * rowHeight,
    rows.reduce((sum, row) => sum + (dividerHeight(row) ?? rowHeight), 0) || rowHeight,
  );
  // Rows are virtualized (absolutely positioned), so size the popup from the content.
  const width = useMemo(() => {
    const chars = Math.max(
      popup.title.length + (popup.pin ? 4 : 0),
      ...popup.items.map(
        (i) =>
          i.label.length +
          (i.leadingDetail?.length ?? 0) +
          (i.preview?.length ?? 0) +
          (i.detail?.length ?? 0) +
          (i.target ? i.target.path.length + (i.target.container?.length ?? 0) + 3 : 0) +
          (i.shortcut?.length ?? 0),
      ),
    );
    const padding = popup.compact ? 44 + (showIcons ? 20 : 0) : 90;
    return Math.min(720, Math.max(popup.compact ? 272 : 320, chars * 7 + padding + (popup.numbered ? 16 : 0)));
  }, [popup, showIcons]);
  const shownPreview = popup.preview
    ? preview && preview.id === activeItem?.id
      ? preview.data
      : activeItem && !activeItem.disabled
        ? ("loading" as const)
        : null
    : null;
  const hasPreview = shownPreview !== null;
  const point = popup.anchor === "center" ? null : popup.anchor;
  const previewBelow = hasPreview && viewportWidth <= MIN_SIDE_BY_SIDE_WIDTH;
  const previewLeft =
    point &&
    hasPreview &&
    !previewBelow &&
    point.x + width + LIST_PREVIEW_WIDTH > viewportWidth - 6 &&
    point.x >= LIST_PREVIEW_WIDTH + 6;
  const anchor = useMemo(() => {
    if (!point || !fetchPreview) return popup.anchor;
    const x = point.x - (previewLeft ? LIST_PREVIEW_WIDTH : 0);
    return {
      getBoundingClientRect: () =>
        new DOMRect(
          Math.max(0, Math.min(x, window.innerWidth)),
          Math.max(0, Math.min(point.y, window.innerHeight)),
          0,
          0,
        ),
    };
  }, [fetchPreview, point, popup.anchor, previewLeft]);
  const leadingDetailChars = Math.max(0, ...popup.items.map((item) => item.leadingDetail?.length ?? 0));
  const popupSize = {
    ...(!copyPath && { width: hasPreview ? width + LIST_PREVIEW_WIDTH : width }),
    "--list-preview-width": `${LIST_PREVIEW_WIDTH}px`,
    "--list-leading-detail-width": `${leadingDetailChars + 1}ch`,
  } as CSSProperties;
  const indexOf = (item: ListPopupItem) => popup.items.indexOf(item);
  return (
    <Popup
      open
      anchor={anchor}
      onClose={closePopup}
      aria-label={popup.title}
      resizable={copyPath ? "both" : undefined}
      className={clsx(
        styles.listPopup,
        hasTargets && styles.targetPopup,
        copyPath && styles.copyPathPopup,
        popup.compact && styles.compactListPopup,
        hasPreview && styles.withPreview,
        previewBelow && styles.previewBelow,
        previewLeft && styles.previewLeft,
        popup.anchor === "center" && styles.centeredList,
      )}
      style={popupSize}
    >
      <div className={styles.listMain} data-testid="list-popup" aria-busy={popup.busy || undefined}>
        <div className={styles.listHeader}>
          <span className={styles.listTitle}>{popup.title}</span>
          {popup.busy && <Spinner size={12} />}
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
            items={rows}
            getKey={(row) => (row.kind === "section" ? row.key : row.item.id)}
            isSection={isListSection}
            sectionHeightOf={dividerHeight}
            renderSection={(row) =>
              row.kind === "section" && row.label ? <T>{row.label}</T> : <span className={styles.listDivider} />
            }
            activeIndex={activeIndex}
            onActiveChange={(index) => {
              const row = rows[index];
              setActiveId(row?.kind === "action" ? row.item.id : null);
            }}
            hoverSelects
            autoFocus
            aria-label={popup.title}
            onActivate={(row) => row.kind === "action" && activate(row.item)}
            empty={
              popup.busy ? (
                <span className={styles.empty}>
                  <T>Computing…</T>
                </span>
              ) : (
                <span className={styles.empty}>
                  <T>Nothing matches</T>
                </span>
              )
            }
            renderItem={(row) => {
              if (row.kind !== "action") return null;
              const { item, match } = row;
              const n = popup.numbered && !query ? indexOf(item) + 1 : 0;
              const name = <HighlightedText className={styles.label} text={item.label} indices={match} tone="accent" />;
              const shortcut = item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>;
              return (
                <div
                  className={clsx(styles.item, item.disabled && styles.disabled, item.emphasis && styles.emphasis)}
                  title={item.disabled ?? undefined}
                  data-testid="list-popup-item"
                  data-path={item.location?.path}
                  data-line={item.location?.line}
                >
                  {leadingDetailChars > 0 && (
                    <span className={styles.leadingDetail} title={item.leadingDetail}>
                      {item.leadingDetail}
                    </span>
                  )}
                  {popup.numbered && <span className={styles.mnemonic}>{n > 0 && n <= 9 ? n : ""}</span>}
                  {showIcons && <ItemIcon item={item} />}
                  {item.target ? (
                    <span className={styles.targetIdentity}>
                      {name}
                      {item.target.container && (
                        <span className={styles.targetContainer} title={item.target.container}>
                          ({item.target.container})
                        </span>
                      )}
                    </span>
                  ) : (
                    name
                  )}
                  {copyPath && shortcut}
                  {item.preview && (
                    <span className={styles.preview} title={item.preview}>
                      {copyPath ? <bdi>{item.preview}</bdi> : item.preview}
                    </span>
                  )}
                  {!item.target && !copyPath && <span className={styles.spacer} />}
                  {item.target && (
                    <span className={styles.targetPath} title={item.target.path}>
                      <bdi>{item.target.path}</bdi>
                    </span>
                  )}
                  {item.detail && <span className={styles.detail}>{item.detail}</span>}
                  {!copyPath && shortcut}
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
      {popup.preview && <ListPreviewPanel preview={shownPreview} themeClasses={popup.themeClasses} />}
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
          <ul className={styles.renameSuggestions} aria-label={tx("Suggested names")}>
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

function SymbolRenameDialog({ popup }: { popup: Extract<LspPopup, { kind: "symbolRename" }> }) {
  const [value, setValue] = useState(popup.initial);
  const field = useId();
  const name = value.trim();
  return (
    <Dialog
      open
      title="Rename"
      aria-label={popup.title}
      onClose={closePopup}
      blockWorkbenchShortcuts
      width={440}
      buttons={[
        {
          label: "Rename",
          role: "default",
          disabled: !name,
          onClick: () => {
            closePopup();
            popup.onSubmit(name);
          },
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={popup.themeClasses}>
        <div className={styles.symbolRename}>
          <div className={styles.renameContext}>{popup.title}</div>
          <label htmlFor={field}>
            <T>New name</T>
          </label>
          <Input
            id={field}
            className={styles.renameField}
            mono
            data-autofocus
            autoSelect
            value={value}
            onChange={(e) => setValue(e.target.value)}
            invalid={!name}
          />
          {popup.note && <div className={styles.symbolRenameNote}>{popup.note}</div>}
        </div>
      </div>
    </Dialog>
  );
}

function DocPopup({ popup }: { popup: Extract<LspPopup, { kind: "doc" }> }) {
  const focusSeq = useLspPopup((s) => s.focusSeq);
  const scope = useRef<HTMLDivElement>(null);
  const opened = useRef(focusSeq);
  // The captured caret can end up outside the viewport while the popup is open.
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () =>
        new DOMRect(
          Math.max(0, Math.min(popup.anchor.x, window.innerWidth)),
          Math.max(0, Math.min(popup.anchor.y, window.innerHeight)),
          0,
          0,
        ),
    }),
    [popup.anchor],
  );
  useEffect(() => {
    if (focusSeq !== opened.current)
      scope.current?.querySelector<HTMLElement>("[data-lsp-doc]")?.focus({ preventScroll: true });
  }, [focusSeq]);
  const [initialSize] = useState(loadDocSize);
  return (
    <Popup
      open
      anchor={anchor}
      onClose={closePopup}
      aria-label="Documentation"
      className={styles.docPopup}
      // As in IDEA the popup leaves the keyboard to the editor until F1 focuses it.
      autoFocus={false}
      resizable="both"
      minWidth={DOC_MIN_WIDTH}
      minHeight={DOC_MIN_HEIGHT}
      initialSize={initialSize}
      onResized={saveDocSize}
    >
      <div ref={scope} data-testid="doc-popup" className={styles.docScope}>
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
  const source = (loc: DefinitionTarget["location"]) => `${relativePath(root, loc.path)}:${loc.range.start.line + 1}`;
  const targetIcon = (path: string) => fileIconName(basename(path), path);
  const open = () => {
    closePopup();
    void openCodeLocation(location.path, { line: location.range.start.line, col: location.range.start.col });
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
    <Popup
      open
      anchor={popup.anchor}
      onClose={closePopup}
      aria-label={tx("Definition")}
      className={styles.defPopup}
      resizable="both"
    >
      <div className={styles.defFrame} tabIndex={-1} data-autofocus onKeyDown={onKeyDown}>
        <div className={styles.defHeader}>
          {many ? (
            <Select
              variant="ghost"
              className={styles.defTarget}
              aria-label="Definition"
              value={String(popup.index)}
              options={popup.targets.map((t, i) => ({
                value: String(i),
                label: t.name,
                verbatim: true,
                icon: targetIcon(t.location.path),
                detail: source(t.location),
              }))}
              onChange={(v) => select(Number(v))}
            />
          ) : (
            <div className={styles.defTarget}>
              <Icon name={targetIcon(location.path)} size={14} />
              <span className={styles.defName} title={target.name}>
                {target.name}
              </span>
            </div>
          )}
          <span className={styles.defPath} title={source(location)}>
            {source(location)}
          </span>
          <div className={styles.defActions}>
            {many && (
              <>
                <IconButton
                  icon="chevron-left"
                  size="small"
                  title="Previous Definition"
                  onClick={() => select(popup.index - 1)}
                />
                <span className={styles.defCount} aria-live="polite">
                  {popup.index + 1}/{popup.targets.length}
                </span>
                <IconButton
                  icon="chevron-right"
                  size="small"
                  title="Next Definition"
                  onClick={() => select(popup.index + 1)}
                />
              </>
            )}
            <IconButton icon="edit" size="small" title="Edit Source" shortcut="F4" onClick={open} />
          </div>
        </div>
        <div
          className={clsx(popup.themeClasses, styles.defBody)}
          style={popup.codeStyle}
          tabIndex={0}
          role="region"
          aria-label={tx("Preview")}
        >
          <DomContent
            key={popup.index}
            className={selectableText}
            build={() => renderCode(target.text, target.language, styles.defCode)}
          />
        </div>
      </div>
    </Popup>
  );
}

const PREVIEW_SIZE_KEY = "openidea.refactor.previewSize";

function loadPreviewSize(): { w: number; h: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(PREVIEW_SIZE_KEY) ?? "null") as { w?: unknown; h?: unknown } | null;
    return typeof v?.w === "number" && typeof v.h === "number" ? { w: v.w, h: v.h } : null;
  } catch {
    return null;
  }
}

function savePreviewSize(size: { w: number; h: number }) {
  try {
    localStorage.setItem(PREVIEW_SIZE_KEY, JSON.stringify(size));
  } catch {
    // Private mode etc. — the size just isn't remembered.
  }
}

function PreviewDialog({ popup }: { popup: Extract<LspPopup, { kind: "preview" }> }) {
  const rename = popup.renameThemeClasses !== undefined;
  const root = useProject((s) => s.project?.root ?? "");
  const { summary } = popup;
  const [initialSize] = useState(loadPreviewSize);
  return (
    <Dialog
      open
      onClose={closePopup}
      title={rename ? "Rename" : popup.title}
      aria-label={popup.title}
      className={clsx(styles.previewDialog, rename && styles.renamePreview)}
      width={560}
      minWidth={400}
      minHeight={220}
      maxHeight={480}
      resizable="both"
      initialSize={initialSize}
      onResized={savePreviewSize}
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
      {rename && <div className={styles.previewContext}>{popup.title}</div>}
      {popup.warnings?.map((w) => (
        <div key={w} className={styles.previewWarning} role="note">
          <Icon name="warning" size={14} />
          <span>{w}</span>
        </div>
      ))}
      <div className={styles.previewSummary}>{describeSummary(summary)}</div>
      {popup.occurrences ? (
        <ul
          className={clsx(styles.previewList, styles.previewOccurrences, popup.renameThemeClasses)}
          aria-label={tx("Occurrences")}
        >
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
        <ul data-testid="refactor-preview" className={styles.previewList} aria-label={tx("Changes")}>
          {summary.entries.map((e) => {
            const name = basename(e.path);
            const directory = relativeDir(root, e.path);
            return (
              <li key={e.path} className={styles.previewRow}>
                <Icon name={fileIconName(name, e.path)} size={14} className={styles.itemIcon} />
                <span className={styles.previewFile} title={relativePath(root, e.path)}>
                  <span className={styles.previewName}>{name}</span>
                  {directory && (
                    <span className={styles.previewDirectory}>
                      <bdi>{directory}</bdi>
                    </span>
                  )}
                </span>
                {e.operation === "rename" && e.to && (
                  <span className={styles.previewOp} title={relativePath(root, e.to)}>
                    → {basename(e.to)}
                  </span>
                )}
                {e.operation && e.operation !== "rename" && <span className={styles.previewOp}>{e.operation}</span>}
                {e.edits > 0 && (
                  <span className={styles.previewCount}>
                    {e.edits} {e.edits === 1 ? "occurrence" : "occurrences"}
                  </span>
                )}
              </li>
            );
          })}
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
      width={400}
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
      <div className={fieldsetStyles.body}>
        <fieldset className={fieldsetStyles.group}>
          <legend className={fieldsetStyles.legend}>
            <T>Scope</T>
          </legend>
          <Radio
            name="reformat-scope"
            checked={selectionOnly}
            disabled={!popup.hasSelection}
            onChange={() => setSelectionOnly(true)}
            label="Selected text"
          />
          <Radio
            name="reformat-scope"
            checked={!selectionOnly}
            onChange={() => setSelectionOnly(false)}
            label="Whole file"
          />
        </fieldset>
        <fieldset className={fieldsetStyles.group}>
          <legend className={fieldsetStyles.legend}>
            <T>Options</T>
          </legend>
          <Checkbox
            checked={optimizeImports}
            disabled={!popup.canOptimizeImports}
            onChange={setOptimizeImports}
            label="Optimize imports"
          />
        </fieldset>
      </div>
    </Dialog>
  );
}

function ImportsOnPasteDialog({ popup }: { popup: Extract<LspPopup, { kind: "importsOnPaste" }> }) {
  const [selected, setSelected] = useState(() => popup.imports.map((_item, i) => i));
  return (
    <Dialog
      open
      title={tx("Add Imports on Paste")}
      onClose={closePopup}
      width={460}
      buttons={[
        {
          label: "Add Imports",
          role: "default",
          disabled: !selected.length,
          onClick: () => void executeAction("code.applyPastedImports", selected),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.pasteImports}>
        <div>
          <T>Select imports to add to the pasted code:</T>
        </div>
        <div className={styles.pasteImportList}>
          {popup.imports.map((label, i) => (
            <Checkbox
              key={i}
              label={label}
              checked={selected.includes(i)}
              onChange={(checked) =>
                setSelected((current) => (checked ? [...current, i] : current.filter((n) => n !== i)))
              }
            />
          ))}
        </div>
      </div>
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
    case "importsOnPaste":
      return <ImportsOnPasteDialog key={seq} popup={popup} />;
    case "list":
      return <ListPopup key={seq} popup={popup} />;
    case "rename":
      return <RenamePopup key={seq} popup={popup} />;
    case "symbolRename":
      return <SymbolRenameDialog key={seq} popup={popup} />;
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
