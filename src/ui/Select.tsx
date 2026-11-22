import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./icons";
import { Popup } from "./Popup";
import { List, listNavigate } from "./List";
import { tx, useGivenTx } from "@/platform/i18n";
import { SearchField } from "./Input";
import { HighlightedText } from "./HighlightedText";
import { fuzzyMatch } from "./match";
import styles from "./Select.module.css";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  /** User values are displayed as written. */
  verbatim?: boolean;
  icon?: IconName | (string & {});
  detail?: string;
  /** User-provided detail is displayed as written. */
  verbatimDetail?: boolean;
  /** Extra text (not shown) that the search should also match. */
  keywords?: string;
  disabled?: boolean;
  /** A non-selectable group heading, independent of disabled options. */
  section?: boolean;
  /** Tree row: indented by `depth`; `expanded` (when set) draws a disclosure chevron. */
  tree?: { depth: number; expanded?: boolean };
}

export interface SelectProps<V extends string = string> {
  id?: string;
  value: V | null;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Preferred focus when rendered inside a dialog. */
  autoFocus?: boolean;
  /** `ghost` renders as plain text + chevron (title bar widgets); `chip` as a chip that opens. */
  variant?: "framed" | "ghost" | "chip";
  className?: string;
  title?: string;
  "aria-label"?: string;
  "aria-description"?: string;
  /** Custom trigger content. */
  renderValue?: (option: SelectOption<V> | undefined) => ReactNode;
  /** Show a search box in the popup (useful for long option lists); typing on the closed trigger opens it with that text. */
  searchable?: boolean;
  /** Optional choice for an exact value entered into the search field. */
  customOption?: (query: string) => SelectOption<V>;
  /** The option under the pointer or keyboard while the list is open; `null` once it closes. */
  onPreview?: (value: V | null) => void;
  /** Choosing an option this returns `true` for keeps the popup open (e.g. expanding a tree row). */
  keepOpen?: (value: V) => boolean;
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
  customOption?: (query: string) => SelectOption<V>;
  /** Search text the list opens with. */
  initialQuery?: string;
  /** Accessible label for the search input. */
  searchLabel?: string;
  highlightMatches?: boolean;
  empty?: ReactNode;
  onPreview?: (value: V | null) => void;
  /** Optional trailing action control rendered at the end of a non-section row. */
  renderAction?: (option: SelectOption<V>) => ReactNode;
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
  customOption,
  initialQuery = "",
  searchLabel,
  highlightMatches,
  empty,
  onPreview,
  renderAction,
  listClassName,
  ...aria
}: SelectListboxProps<V>) {
  const given = useGivenTx();
  const labelOf = (o: SelectOption<V>) => (o.verbatim ? o.label : given(o.label));
  const detailOf = (o: SelectOption<V>) => (o.verbatimDetail ? o.detail : given(o.detail));
  const [active, setActive] = useState<number | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const listId = useId();
  const caretPlaced = useRef(false);
  const typeAhead = useRef({ text: "", at: -Infinity });
  const isSection = (o: SelectOption<V>) => !!o.section;
  const unavailable = (o: SelectOption<V>) => !!(o.section || o.disabled);
  const matching =
    searchable && query.trim()
      ? (() => {
          const q = query.trim().toLowerCase();
          const tokens = q.split(/\s+/).filter(Boolean);
          const matches = (o: SelectOption<V>) => {
            const haystack = `${labelOf(o)} ${detailOf(o) ?? ""} ${o.keywords ?? ""}`.toLowerCase();
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
  const typed = query.trim();
  const custom =
    searchable &&
    typed &&
    customOption &&
    !options.some((o) => !o.section && (o.value === typed || labelOf(o) === typed))
      ? customOption(typed)
      : undefined;
  const filtered = custom ? [...matching, custom] : matching;

  const preferred = active ?? filtered.findIndex((o) => o.value === value && !unavailable(o));
  const activeIndex =
    filtered[preferred] && !unavailable(filtered[preferred]!) ? preferred : filtered.findIndex((o) => !unavailable(o));

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
    if (e.nativeEvent.isComposing) return;
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
            onFocus={(e) => {
              // Keep typing after the text that opened the list instead of before it.
              if (caretPlaced.current) return;
              caretPlaced.current = true;
              const end = e.currentTarget.value.length;
              e.currentTarget.setSelectionRange(end, end);
            }}
            placeholder={tx("Search…")}
            aria-label={searchLabel}
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
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
            {o.tree && <TreeIndent {...o.tree} />}
            {o.icon && <Icon name={o.icon} size={14} />}
            <span>{labelOf(o)}</span>
            {o.detail && <span className={styles.sizerDetail}>{detailOf(o)}</span>}
          </div>
        ))}
      </div>
      <List
        id={listId}
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
        empty={empty}
        aria-label={given(aria["aria-label"])}
        className={clsx(styles.list, listClassName)}
        renderItem={(o) => {
          const action = !o.section && !o.disabled ? renderAction?.(o) : null;
          const label = labelOf(o);
          const detail = detailOf(o);
          const highlight = (text: string) =>
            highlightMatches && typed ? <HighlightedText text={text} indices={fuzzyMatch(text, typed)} /> : text;
          return (
            <span
              className={clsx(styles.option, o.disabled && styles.disabled)}
              aria-disabled={o.disabled || undefined}
            >
              <span className={styles.check}>{o.value === value && <Icon name="check" size={12} />}</span>
              {o.tree && <TreeIndent {...o.tree} />}
              {o.icon && <Icon name={o.icon} size={14} />}
              <span className={clsx(styles.optionLabel, detail && styles.withDetail)} title={label}>
                {highlight(label)}
              </span>
              {detail && (
                <span className={styles.detail} title={detail}>
                  {highlight(detail)}
                </span>
              )}
              {action && (
                <span
                  className={styles.rowAction}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                  }}
                >
                  {action}
                </span>
              )}
            </span>
          );
        }}
      />
    </div>
  );
}

function TreeIndent({ depth, expanded }: { depth: number; expanded?: boolean }) {
  return (
    <span className={styles.treeIndent} style={{ "--tree-depth": depth } as CSSProperties}>
      {expanded !== undefined && <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />}
    </span>
  );
}

/** Dropdown select with a listbox popup (↑↓ Enter Esc, type-ahead). */
export function Select<V extends string = string>({
  value,
  options,
  onChange,
  placeholder = "Select…",
  disabled,
  autoFocus,
  variant = "framed",
  className,
  title,
  renderValue,
  searchable = false,
  customOption,
  onPreview,
  keepOpen,
  ...aria
}: SelectProps<V>) {
  const given = useGivenTx();
  const [open, setOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => !o.section && o.value === value);
  const openPopup = (query = "") => {
    setInitialQuery(query);
    setOpen(true);
  };
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
        data-autofocus={autoFocus ? "" : undefined}
        aria-description={aria["aria-description"]}
        title={title}
        disabled={disabled}
        className={clsx(styles.trigger, styles[variant], className)}
        onClick={() => (open ? setOpen(false) : openPopup())}
        onKeyDown={(e) => {
          if (open) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openPopup();
          } else if (
            searchable &&
            e.key.length === 1 &&
            e.key !== " " &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            !e.nativeEvent.isComposing
          ) {
            // Type to search: the key starts the query instead of being lost on the button.
            e.preventDefault();
            openPopup(e.key);
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
          customOption={customOption}
          initialQuery={initialQuery}
          onPreview={preview}
          aria-label={aria["aria-label"]}
          onChoose={(v) => {
            onChange(v);
            if (!keepOpen?.(v)) setOpen(false);
          }}
        />
      </Popup>
    </>
  );
}
