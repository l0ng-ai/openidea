import { useLayoutEffect, useState, type KeyboardEvent, type RefObject } from "react";
import clsx from "clsx";
import { useGivenTx } from "@/platform/i18n";
import { IconButton } from "./Button";
import { Icon } from "./icons";
import { List } from "./List";
import { Popup } from "./Popup";
import { Given } from "./T";
import { useRowHeight } from "./density";
import type { TabItem } from "./Tabs";
import styles from "./HiddenTabsPopup.module.css";

const DIVIDER_HEIGHT = 8;
const isDivider = (item: TabItem | null) => item === null;

interface Props {
  anchor: RefObject<HTMLButtonElement | null>;
  scroller: RefObject<HTMLDivElement | null>;
  buttons: RefObject<Map<string, HTMLButtonElement>>;
  items: readonly TabItem[];
  closePosition: "left" | "right";
  onSelect: (id: string) => void;
  onCloseTab?: (id: string) => void;
  onCloseOthers?: (id: string) => void;
  onTogglePin?: (id: string) => void;
  onDismiss: () => void;
}

export function HiddenTabsPopup({
  anchor,
  scroller,
  buttons,
  items,
  closePosition,
  onSelect,
  onCloseTab,
  onCloseOthers,
  onTogglePin,
  onDismiss,
}: Props) {
  const tr = useGivenTx();
  const rowHeight = useRowHeight(26);
  const [rows, setRows] = useState<(TabItem | null)[]>([]);
  const [position, setPosition] = useState(0);

  useLayoutEffect(() => {
    const viewport = scroller.current;
    if (!viewport) return;
    const measure = () => {
      const left = viewport.getBoundingClientRect().left + viewport.clientLeft;
      const right = left + viewport.clientWidth;
      const before: TabItem[] = [];
      const after: TabItem[] = [];
      for (const item of items) {
        const rect = buttons.current.get(item.id)?.parentElement?.getBoundingClientRect();
        if (!rect) continue;
        if (rect.left < left - 1) before.push(item);
        else if (rect.right > right + 1) after.push(item);
      }
      if (!before.length && !after.length) onDismiss();
      setRows(before.length && after.length ? [...before, null, ...after] : [...before, ...after]);
    };
    measure();
    viewport.addEventListener("scroll", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    for (const button of buttons.current.values()) {
      if (button.parentElement) observer.observe(button.parentElement);
    }
    return () => {
      viewport.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [buttons, items, onDismiss, scroller]);

  const active = Math.min(position, rows.length - 1);
  const activeIndex = rows[active] === null ? active + 1 : active;
  const pick = (item: TabItem) => {
    onDismiss();
    onSelect(item.id);
  };
  const labelOf = (item: TabItem) => item.text ?? (typeof item.label === "string" ? tr(item.label) : item.id);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const item = rows[activeIndex];
    if (event.key === " " && item) pick(item);
    else if (event.key === "Delete" && item && item.closable !== false && onCloseTab) onCloseTab(item.id);
    else if (event.key.length === 1) {
      const start = activeIndex + 1;
      const prefix = event.key.toLocaleLowerCase();
      const match = [...rows.slice(start), ...rows.slice(0, start)].find(
        (row) => row && labelOf(row).toLocaleLowerCase().startsWith(prefix),
      );
      if (!match) return;
      setPosition(rows.indexOf(match));
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const hasDivider = rows.includes(null);
  const totalHeight = (rows.length - Number(hasDivider)) * rowHeight + (hasDivider ? DIVIDER_HEIGHT : 0);
  return (
    <Popup
      open={rows.length > 0}
      anchor={anchor}
      onClose={onDismiss}
      placement="bottom-end"
      role="presentation"
      trapFocus
      className={styles.popup}
    >
      <div
        className={styles.grid}
        role="grid"
        aria-label={tr("Hidden Editor Tabs")}
        aria-rowcount={rows.length - Number(hasDivider)}
        style={{ height: Math.min(totalHeight, rowHeight * 10) }}
        onKeyDown={onKeyDown}
      >
        <List
          items={rows}
          getKey={(item) => item?.id ?? "divider"}
          isSection={isDivider}
          renderSection={() => <span className={styles.divider} />}
          sectionHeight={DIVIDER_HEIGHT}
          rowHeight={rowHeight}
          activeIndex={activeIndex}
          onActiveChange={setPosition}
          onActivate={(item) => item && pick(item)}
          tableBody={{ headerRows: 0 }}
          autoFocus
          hoverSelects
          className={styles.list}
          renderItem={(item) => {
            if (!item) return null;
            const unpin = item.pinned && onTogglePin;
            const close = onCloseTab && item.closable !== false && item.showCloseButton !== false;
            const action = (
              <div role="gridcell" className={styles.action}>
                {item.modified && <span className={styles.modified} aria-label={tr("Modified")} />}
                {(unpin || close) && (
                  <IconButton
                    icon={unpin ? "pin" : "close"}
                    title={unpin ? "Unpin Tab" : "Close Tab"}
                    size="small"
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (unpin) unpin(item.id);
                      else if (event.altKey && onCloseOthers) onCloseOthers(item.id);
                      else onCloseTab!(item.id);
                    }}
                  />
                )}
              </div>
            );
            return (
              <>
                {closePosition === "left" && action}
                <div role="gridcell" className={styles.name} style={{ color: item.color }}>
                  {item.icon && <Icon name={item.icon} size={16} />}
                  <span
                    className={clsx(styles.label, item.italic && styles.italic)}
                    title={item.tooltip ?? labelOf(item)}
                  >
                    {typeof item.label === "string" ? <Given>{item.label}</Given> : item.label}
                  </span>
                  {item.trailing}
                </div>
                {closePosition === "right" && action}
              </>
            );
          }}
        />
      </div>
    </Popup>
  );
}
