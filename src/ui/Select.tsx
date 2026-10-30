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
  disabled?: boolean;
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
  const current = options.find((o) => o.value === value);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const typeAhead = useRef({ text: "", at: -Infinity });
  const isSection = (o: SelectOption<V>) => !!o.disabled;
  const filtered =
    searchable && query.trim()
      ? options.filter((o) => !o.disabled && tx(o.label).toLowerCase().includes(query.trim().toLowerCase()))
      : options;

  const openPopup = () => {
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  };

  const choose = (o: SelectOption<V> | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
  };

  const onPopupKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(filtered[active]);
      return;
    }
    const next = listNavigate(e.key, { items: options, active, isSection, wrap: true });
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
        const i = (active + s) % n;
        if (!filtered[i]!.disabled && tx(filtered[i]!.label).toLowerCase().startsWith(prefix)) {
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
        <div tabIndex={-1} data-autofocus onKeyDown={onPopupKey} className={styles.popupInner}>
          {searchable && (
            <div className={styles.searchWrap}>
              <SearchField
                value={query}
                autoFocus
                placeholder={tx("Search…")}
                onChange={(v) => {
                  setQuery(v);
                  setActive(0);
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
              <div key={o.value} className={styles.sizerRow}>
                <span className={styles.check} />
                {o.icon && <Icon name={o.icon} size={14} />}
                <span>{tx(o.label)}</span>
                {o.detail && <span className={styles.sizerDetail}>{tx(o.detail)}</span>}
              </div>
            ))}
          </div>
          <List
            items={filtered}
            getKey={(o) => o.value}
            isSection={isSection}
            renderSection={(o) => <span className={styles.disabled}>{tx(o.label)}</span>}
            activeIndex={active}
            onActiveChange={setActive}
            onActivate={(o) => choose(o)}
            focusable={false}
            hoverSelects
            rowHeight={24}
            aria-label={tx(aria["aria-label"])}
            className={styles.list}
            renderItem={(o) => (
              <>
                <span className={styles.check}>{o.value === value && <Icon name="check" size={12} />}</span>
                {o.icon && <Icon name={o.icon} size={14} />}
                <span className={clsx(styles.optionLabel, o.detail && styles.withDetail)}>{tx(o.label)}</span>
                {o.detail && (
                  <span className={styles.detail} title={o.detail}>
                    {tx(o.detail)}
                  </span>
                )}
              </>
            )}
          />
        </div>
      </Popup>
    </>
  );
}
