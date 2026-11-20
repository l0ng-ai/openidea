import { useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { HighlightedText, List, Popup, fuzzyMatch, listNavigate } from "@/ui";
import { closeChooser, useChooser, type ChooserItem, type ChooserRequest } from "./store";
import styles from "./Chooser.module.css";
import { tx } from "@/platform/i18n";
import { useRowHeight } from "@/ui/density";

/** Overlay contribution: renders the pending chooser, if any. */
export function ChooserHost() {
  const { request, seq } = useChooser();
  if (!request) return null;
  return <ChooserPopup key={seq} request={request} />;
}

interface Row {
  item: ChooserItem;
  matches: number[] | null;
}

export function filterChooserItems(items: readonly ChooserItem[], filter: string): Row[] {
  if (!filter) return items.map((item) => ({ item, matches: null }));
  const q = filter.toLowerCase();
  const prefix: Row[] = [];
  const fuzzy: Row[] = [];
  for (const item of items) {
    if (item.section) continue;
    if (item.label.toLowerCase().startsWith(q)) prefix.push({ item, matches: [...Array(q.length).keys()] });
    else {
      const m = fuzzyMatch(item.label, filter);
      if (m) fuzzy.push({ item, matches: m });
      else if (item.search && item.search.toLowerCase().includes(q)) fuzzy.push({ item, matches: null });
    }
  }
  return [...prefix, ...fuzzy];
}

const isSection = (r: Row) => !!r.item.section;

/** The label with its mnemonic underlined (IDEA: `1. if`, `T. Surround with…`). */
function MnemonicLabel({ item }: { item: ChooserItem }) {
  const m = item.mnemonic;
  if (!m) return <>{item.label}</>;
  const i = item.mnemonicIndex;
  if (i === undefined)
    return (
      <>
        <u>{m}</u>. {item.label}
      </>
    );
  return (
    <>
      {item.label.slice(0, i)}
      <u>{item.label.slice(i, i + 1)}</u>
      {item.label.slice(i + 1)}
    </>
  );
}

function ChooserPopup({ request }: { request: ChooserRequest }) {
  const rowHeight = useRowHeight(22);
  const [filter, setFilter] = useState(request.filter ?? "");
  const rows = useMemo(() => filterChooserItems(request.items, filter), [request.items, filter]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      rows.findIndex((r) => !isSection(r)),
    ),
  );
  const current = Math.min(active, rows.length - 1);

  const close = () => {
    closeChooser();
    request.onCancel?.();
  };
  const pick = (row: Row | undefined) => {
    if (!row || row.item.section) return;
    closeChooser();
    request.onPick(row.item, filter);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const next = listNavigate(e.key, { items: rows, active: current, wrap: true, isSection });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(rows[current]);
    } else if (request.mnemonics && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const key = e.key.toUpperCase();
      pick(rows.find((r) => r.item.mnemonic?.toUpperCase() === key));
    } else if (request.filterable && e.key === "Backspace") {
      e.preventDefault();
      setFilter((f) => f.slice(0, -1));
      setActive(0);
    } else if (request.filterable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setFilter((f) => f + e.key);
      setActive(0);
    }
  };

  return (
    <Popup
      open
      anchor={request.anchor}
      placement="bottom-start"
      offset={2}
      onClose={close}
      role="dialog"
      aria-label={request.title}
      className={styles.popup}
    >
      <div className={styles.body} tabIndex={0} data-autofocus onKeyDown={onKeyDown}>
        <div className={styles.header}>
          <span className={styles.title}>{request.title}</span>
          {request.filterable && filter && <span className={styles.filter}>{filter}</span>}
        </div>
        <List
          items={rows}
          getKey={(r) => r.item.key}
          activeIndex={current}
          onActiveChange={setActive}
          onActivate={(r) => pick(r)}
          isSection={isSection}
          sectionHeight={22}
          renderSection={(r) => <div className={styles.section}>{r.item.label}</div>}
          focusable={false}
          hoverSelects
          rowHeight={rowHeight}
          className={styles.list}
          aria-label={request.title}
          empty={<div className={styles.empty}>{request.emptyText ?? tx("Nothing to show")}</div>}
          renderItem={(r, state) => (
            <div className={clsx(styles.row, state.active && styles.active)}>
              <span className={styles.label}>
                {r.item.mnemonic ? (
                  <MnemonicLabel item={r.item} />
                ) : (
                  <HighlightedText text={r.item.label} indices={r.matches ?? undefined} />
                )}
              </span>
              {r.item.detail && <span className={styles.detail}>{r.item.detail}</span>}
            </div>
          )}
        />
      </div>
    </Popup>
  );
}
