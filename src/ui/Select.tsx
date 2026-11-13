import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./icons";
import { Popup } from "./Popup";
import { List, listNavigate } from "./List";
import { tx, useGivenTx } from "@/platform/i18n";
import { SearchField } from "./Input";
import styles from "./Select.module.css";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  /** User values are displayed as written. */
  verbatim?: boolean;
  icon?: IconName | (string & {});
  detail?: string;
  /** Extra text (not shown) that the search should also match. */
  keywords?: string;
  disabled?: boolean;
  /** A non-selectable group heading, independent of disabled options. */
  section?: boolean;
}

export interface SelectProps<V extends string = string> {
  id?: string;
  value: V | null;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  placeholder?: string;
  disabled?: boolean;
  /** `ghost` renders as plain text + chevron (title bar widgets); `chip` as a chip that opens. */
  variant?: "framed" | "ghost" | "chip";
  className?: string;
  "aria-label"?: string;
  /** Custom trigger content. */
  renderValue?: (option: SelectOption<V> | undefined) => ReactNode;
  /** Show a search box in the popup (useful for long option lists). */
  searchable?: boolean;
  /** The option under the pointer or keyboard while the list is open; `null` once it closes. */
  onPreview?: (value: V | null) => void;
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

export interface SelectListboxProps<V extends string = string> {
  value: V | null;
  options: readonly SelectOption<V>[];
  /** Called with the chosen option; closing, if any, is the caller's. */
  onChoose: (value: V) => void;
  searchable?: boolean;
  onPreview?: (value: V | null) => void;
  /** Extra class for the scrolling list, e.g. to set its height. */
  listClassName?: string;
  "aria-label"?: string;
}

/** The searchable listbox of a {@link Select}, for a popup that shows it without a trigger button. */
export function SelectListbox<V extends string = string>({
  value,
  options,
  onChoose,
  searchable = false,
  onPreview,
  listClassName,
  ...aria
}: SelectListboxProps<V>) {
  const given = useGivenTx();
  const labelOf = (o: SelectOption<V>) => (o.verbatim ? o.label : given(o.label));
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => !o.section && !o.disabled && o.value === value),
    ),
  );
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
            const haystack =
              `${labelOf(o)} ${o.detail != null ? given(o.detail) : ""} ${o.keywords ?? ""}`.toLowerCase();
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

  const previewed = filtered[activeIndex]?.value ?? null;
  const lastPreview = useRef<V | null>(null);
  const previewRef = useRef(onPreview);
  useLayoutEffect(() => {
    previewRef.current = onPreview;
  });
  useEffect(() => {
    if (previewed === lastPreview.current) return;
    lastPreview.current = previewed;
    onPreview?.(previewed);
  }, [previewed, onPreview]);
  // The list is only mounted while open: closing it ends the preview.
  useEffect(
    () => () => {
      if (lastPreview.current !== null) previewRef.current?.(null);
      lastPreview.current = null;
    },
    [],
  );

  const choose = (o: SelectOption<V> | undefined) => {
    if (!o || unavailable(o)) return;
    onChoose(o.value);
  };

  const onPopupKey = (e: KeyboardEvent) => {
    const searching = searchable && e.target instanceof HTMLInputElement;
    if (e.key === "Enter" || (e.key === " " && !searching)) {
      e.preventDefault();
      choose(filtered[activeIndex]);
      return;
    }
    if (searching && !["ArrowDown", "ArrowUp"].includes(e.key)) return;
    const next = listNavigate(e.key, {
      items: filtered,
      active: activeIndex,
      isSection: unavailable,
      wrap: true,
    });
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
        if (!unavailable(filtered[i]!) && labelOf(filtered[i]!).toLowerCase().startsWith(prefix)) {
          setActive(i);
          break;
        }
      }
    }
  };

  return (
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
            data-autofocus
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
            <span>{labelOf(o)}</span>
            {o.detail && <span className={styles.sizerDetail}>{given(o.detail)}</span>}
          </div>
        ))}
      </div>
      <List
        items={filtered}
        getKey={(o) => `${o.section ? "section" : "option"}:${o.value}`}
        isSection={isSection}
        renderSection={(o) => <span className={styles.disabled}>{labelOf(o)}</span>}
        activeIndex={activeIndex}
        onActiveChange={(i) => {
          if (!unavailable(filtered[i]!)) setActive(i);
        }}
        onActivate={(o) => choose(o)}
        focusable={false}
        hoverSelects
        rowHeight={24}
        aria-label={given(aria["aria-label"])}
        className={clsx(styles.list, listClassName)}
        renderItem={(o) => (
          <span className={clsx(styles.option, o.disabled && styles.disabled)} aria-disabled={o.disabled || undefined}>
            <span className={styles.check}>{o.value === value && <Icon name="check" size={12} />}</span>
            {o.icon && <Icon name={o.icon} size={14} />}
            <span className={clsx(styles.optionLabel, o.detail && styles.withDetail)} title={labelOf(o)}>
              {labelOf(o)}
            </span>
            {o.detail && (
              <span className={styles.detail} title={o.detail}>
                {given(o.detail)}
              </span>
            )}
          </span>
        )}
      />
    </div>
  );
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
  onPreview,
  ...aria
}: SelectProps<V>) {
  const given = useGivenTx();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => !o.section && o.value === value);
  const openPopup = () => setOpen(true);
  // Selection can update the callback as the list unmounts; use the committed trigger props.
  const previewRef = useRef(onPreview);
  useLayoutEffect(() => {
    previewRef.current = onPreview;
  });
  const preview = useCallback((next: V | null) => previewRef.current?.(next), []);

  return (
    <>
      <button
        ref={triggerRef}
        id={aria.id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={given(aria["aria-label"])}
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
              {current?.verbatim ? current.label : given(current?.label ?? placeholder)}
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
        <SelectListbox
          value={value}
          options={options}
          searchable={searchable}
          onPreview={preview}
          aria-label={aria["aria-label"]}
          onChoose={(v) => {
            onChange(v);
            setOpen(false);
          }}
        />
      </Popup>
    </>
  );
}
