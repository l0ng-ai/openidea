import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { HighlightedText, Icon, Popup, SearchField, T } from "@/ui";
import { fuzzyMatch } from "@/ui/match";
import { tx } from "@/platform/i18n";
import styles from "./GitLog.module.css";

export function BranchFilterPopup({
  anchor,
  branches,
  selected,
  onSelect,
  onSelectMany,
  onClose,
}: {
  anchor: HTMLElement;
  branches: readonly string[];
  selected: readonly string[];
  onSelect: (branch: string) => void;
  onSelectMany: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const options = [
    { value: "HEAD", label: tx("HEAD (Current Branch)") },
    ...branches.map((name) => ({ value: name, label: name })),
  ]
    .map((item) => ({ ...item, matches: fuzzyMatch(item.label, query.trim()) }))
    .filter((item) => item.matches !== null);
  const index = Math.min(active, options.length - 1);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [index, query]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length) setActive((index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (event.key === "Enter" && index >= 0) {
      event.preventDefault();
      onSelect(options[index]!.value);
    }
  };
  return (
    <Popup
      open
      anchor={anchor}
      onClose={onClose}
      className={styles.branchFilterPopup}
      aria-label={tx("Filter by Branch")}
    >
      <div className={styles.branchFilterSearch}>
        <SearchField
          data-autofocus
          variant="bare"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search branches"
          aria-label="Search branches"
        />
      </div>
      <div ref={list} className={styles.branchFilterList} role="listbox" aria-label={tx("Branches")}>
        {options.map((item, i) => (
          <button
            key={item.value}
            type="button"
            role="option"
            aria-selected={selected.includes(item.value)}
            data-active={i === index}
            className={styles.branchFilterOption}
            onMouseEnter={() => setActive(i)}
            onClick={() => onSelect(item.value)}
          >
            <Icon name="branch" size={14} /> <HighlightedText text={item.label} indices={item.matches} tone="accent" />
            {selected.includes(item.value) && <Icon name="check" size={14} />}
          </button>
        ))}
        {!options.length && (
          <div className={styles.branchFilterEmpty}>
            <T>No matching branches</T>
          </div>
        )}
      </div>
      <button type="button" className={styles.branchFilterMore} onClick={onSelectMany}>
        <T>Select…</T>
      </button>
    </Popup>
  );
}
