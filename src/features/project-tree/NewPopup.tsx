import { useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { HighlightedText, Icon, Input, List, Popup, T, firstSelectable, listNavigate, type MenuItem } from "@/ui";
import { closeNewPopup, newPopupRows, useNewPopup, type NewPopupRow } from "./newPopupModel";
import styles from "./NewPopup.module.css";

const isSeparator = (r: NewPopupRow) => !!r.separator;

/** Overlay: IDEA's "New" popup — file kinds with a type-to-filter field. */
export function NewPopupHost() {
  const request = useNewPopup((s) => s.request);
  if (!request) return null;
  return <NewPopup key={request.seq} at={request.at} items={request.items} />;
}

function NewPopup({ at, items }: { at: { x: number; y: number }; items: MenuItem[] }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const rows = useMemo(() => newPopupRows(items, query), [items, query]);
  const current =
    active >= 0 && active < rows.length && !rows[active]!.separator ? active : firstSelectable(rows, isSeparator);

  const pick = (row: NewPopupRow | undefined) => {
    if (!row?.run) return;
    closeNewPopup();
    row.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const next = listNavigate(e.key === "ArrowUp" || e.key === "ArrowDown" ? e.key : "", {
      items: rows,
      active: current,
      isSection: isSeparator,
      wrap: true,
    });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(rows[current]);
    }
  };

  return (
    <Popup
      open
      anchor={at}
      placement="bottom-start"
      onClose={closeNewPopup}
      role="dialog"
      aria-label="New"
      className={styles.popup}
    >
      <div className={styles.search}>
        <Icon name="search" size={14} className={styles.searchIcon} />
        <Input
          variant="bare"
          data-autofocus
          value={query}
          placeholder="Search for file type"
          aria-label="Search for file type"
          className={styles.input}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <List
        items={rows}
        getKey={(r) => r.key}
        isSection={isSeparator}
        renderSection={() => <div className={styles.separator} />}
        sectionHeight={9}
        activeIndex={current}
        onActiveChange={setActive}
        onActivate={(r) => pick(r)}
        focusable={false}
        hoverSelects
        className={styles.list}
        aria-label="File types"
        empty={
          <div className={styles.empty}>
            <T>Nothing found</T>
          </div>
        }
        renderItem={(r, state) => (
          <div className={clsx(styles.row, state.active && styles.active)}>
            <span className={styles.icon}>{r.icon && <Icon name={r.icon} size={16} />}</span>
            <span className={styles.label}>
              <HighlightedText text={r.label} indices={r.matches ?? undefined} />
            </span>
            {r.shortcut && <span className={styles.shortcut}>{r.shortcut}</span>}
          </div>
        )}
      />
    </Popup>
  );
}
