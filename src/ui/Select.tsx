import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./icons";
import { Popup } from "./Popup";
import { List, listNavigate } from "./List";
import { useTx } from "@/platform/i18n";
import { SearchField } from "./Input";
import styles from "./Select.module.css";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  icon?: IconName | (string & {});
  detail?: string;
  /** Extra text (not shown) that the search should also match. */
  keywords?: string;
  disabled?: boolean;
  /** A non-selectable group heading, independent of disabled options. */
  section?: boolean;
}

export interface SelectProps<V extends string = string> {
  value: V | null;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  placeholder?: string;
  disabled?: boolean;
  /** `ghost` renders as plain text + chevron (title bar widgets). */
  variant?: "framed" | "ghost";
  className?: string;
  "aria-label"?: string;
  /** Custom trigger content. */
  renderValue?: (option: SelectOption<V> | undefined) => ReactNode;
  /** Show a search box in the popup (useful for long option lists). */
  searchable?: boolean;
}

const TYPE_AHEAD_MS = 800;

/** Substring or subsequence (fuzzy) match. */
function containsOrFuzzy(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true;
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i >= needle.length) return true;
  }
  return false;
}

/** Dropdown select with a listbox popup (↑↓ Enter Esc, type-ahead). */
export function Select<V extends string = string>({
  value,
  options,
  onChange,
  placeholder = "Select…",
  disabled,
  variant = "framed",
  className,
  renderValue,
  searchable = false,
  ...aria
}: SelectProps<V>) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => !o.section && o.value === value);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const typeAhead = useRef({ text: "", at: -Infinity });
  const isSection = (o: SelectOption<V>) => !!o.section;
  const unavailable = (o: SelectOption<V>) => !!(o.section || o.disabled);
  const filtered =
    searchable && query.trim()
      ? (() => {
          const q = query.trim().toLowerCase();
          const tokens = q.split(/\s+/).filter(Boolean);
          const matches = (o: SelectOption<V>) => {
            const haystack = `${tx(o.label)} ${o.detail != null ? tx(o.detail) : ""} ${o.keywords ?? ""}`.toLowerCase();
            return tokens.every((tok) => containsOrFuzzy(haystack, tok));
          };
          // Keep section headers visible as long as at least one of their
          // items matches, so the provider grouping survives filtering.
          const out: SelectOption<V>[] = [];
          let section: SelectOption<V> | null = null;
          let bucket: SelectOption<V>[] = [];
          let sectionMatched = false;
          const flush = () => {
            if (section && sectionMatched) {
              out.push(section, ...bucket);
            } else if (!section && bucket.length) {
              out.push(...bucket);
            }
            section = null;
            bucket = [];
            sectionMatched = false;
          };
          for (const o of options) {
            if (o.section) {
              flush();
              section = o;
            } else if (matches(o)) {
              bucket.push(o);
              sectionMatched = true;
            }
          }
          flush();
          return out;
        })()
      : options;

  const activeIndex =
    filtered[active] && !unavailable(filtered[active]!) ? active : filtered.findIndex((o) => !unavailable(o));

  const openPopup = () => {
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((o) => !unavailable(o) && o.value === value),
      ),
    );
    setOpen(true);
  };

  const choose = (o: SelectOption<V> | undefined) => {
    if (!o || unavailable(o)) return;
    onChange(o.value);
    setOpen(false);
  };

  const onPopupKey = (e: KeyboardEvent) => {
    const searching = searchable && e.target instanceof HTMLInputElement;
    if (e.key === "Enter" || (e.key === " " && !searching)) {
      e.preventDefault();
      choose(filtered[activeIndex]);
      return;
    }
    if (searching && !["ArrowDown", "ArrowUp"].includes(e.key)) return;
    const next = listNavigate(e.key, { items: filtered, active: activeIndex, isSection: unavailable, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      // Keys typed in quick succession extend the prefix ("me" → Menlo); a lone key cycles.
      const ahead = typeAhead.current;
      ahead.text = e.timeStamp - ahead.at < TYPE_AHEAD_MS ? ahead.text + e.key.toLowerCase() : e.key.toLowerCase();
      ahead.at = e.timeStamp;
      const repeat = ahead.text.length > 1 && [...ahead.text].every((c) => c === ahead.text[0]);
      const prefix = repeat ? ahead.text[0]! : ahead.text;
      const n = filtered.length;
      for (let s = prefix.length > 1 ? 0 : 1; s <= n; s++) {
        const i = (activeIndex + s) % n;
        if (!unavailable(filtered[i]!) && tx(filtered[i]!.label).toLowerCase().startsWith(prefix)) {
          setActive(i);
          break;
        }
      }
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={tx(aria["aria-label"])}
        disabled={disabled}
        className={clsx(styles.trigger, styles[variant], className)}
        onClick={() => (open ? setOpen(false) : openPopup())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openPopup();
          }
        }}
      >
        {renderValue ? (
          <span className={styles.value}>{renderValue(current)}</span>
        ) : (
          <>
            {current?.icon && <Icon name={current.icon} size={14} />}
            <span className={clsx(styles.value, !current && styles.placeholder)}>
              {tx(current?.label ?? placeholder)}
            </span>
          </>
        )}
        <Icon name="chevron-down" size={14} className={styles.chevron} />
      </button>
      <Popup
        open={open}
        onClose={() => setOpen(false)}
        anchor={triggerRef}
        matchWidth
        role="presentation"
        className={styles.popup}
      >
        <div
          tabIndex={-1}
          data-autofocus={searchable ? undefined : true}
          onKeyDown={onPopupKey}
          className={styles.popupInner}
        >
          {searchable && (
            <div className={styles.searchWrap}>
              <SearchField
                value={query}
                autoFocus
                placeholder={tx("Search…")}
                onChange={(v) => {
                  setQuery(v);
                  setActive(-1);
                }}
                size="normal"
                variant="framed"
                className={styles.search}
              />
            </div>
          )}
          {/* Virtualised rows are absolutely positioned; this sizes the popup to the widest label. */}
          <div aria-hidden className={styles.sizer}>
            {options.map((o) => (
              <div key={`${o.section ? "section" : "option"}:${o.value}`} className={styles.sizerRow}>
                <span className={styles.check} />
                {o.icon && <Icon name={o.icon} size={14} />}
                <span>{tx(o.label)}</span>
                {o.detail && <span className={styles.sizerDetail}>{tx(o.detail)}</span>}
              </div>
            ))}
          </div>
          <List
            items={filtered}
            getKey={(o) => `${o.section ? "section" : "option"}:${o.value}`}
            isSection={isSection}
            renderSection={(o) => <span className={styles.disabled}>{tx(o.label)}</span>}
            activeIndex={activeIndex}
            onActiveChange={(i) => {
              if (!unavailable(filtered[i]!)) setActive(i);
            }}
            onActivate={(o) => choose(o)}
            focusable={false}
            hoverSelects
            rowHeight={24}
            aria-label={tx(aria["aria-label"])}
            className={styles.list}
            renderItem={(o) => (
              <span
                className={clsx(styles.option, o.disabled && styles.disabled)}
                aria-disabled={o.disabled || undefined}
              >
                <span className={styles.check}>{o.value === value && <Icon name="check" size={12} />}</span>
                {o.icon && <Icon name={o.icon} size={14} />}
                <span className={clsx(styles.optionLabel, o.detail && styles.withDetail)}>{tx(o.label)}</span>
                {o.detail && (
                  <span className={styles.detail} title={o.detail}>
                    {tx(o.detail)}
                  </span>
                )}
              </span>
            )}
          />
        </div>
      </Popup>
    </>
  );
}
