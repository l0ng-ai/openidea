/**
 * The list's search panel (`ReviewListSearchPanelFactory` / `GHPRSearchPanelFactory`):
 * the search field (Enter applies the text; the history icon or ⌥↓ opens the last 10
 * searches), then the Quick Filters funnel and a horizontally scrolling row of chips —
 * State, Author, Label, Assignee, Review, Sort.
 *
 * Chips are IntelliJ's `FilterComponent`: the filter's name and a chevron while unset,
 * else the value and a reset ✕; Delete / Backspace resets. The popup opens 4px below.
 * As in IntelliJ, closing a chip's popup without choosing resets the chip.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { tx, useTx } from "@/platform/i18n";
import { Icon, IconButton, Menu, SearchField, showContextMenu, type MenuItem } from "@/ui";
import type { GHLabel, GHUser } from "../api/types";
import { filterCount, type PrSearchValue } from "../data/model";
import { useAuthorCandidates, useRepositoryList } from "../data/repository";
import { loadSearchHistory } from "../data/searchHistory";
import type { BatchesState } from "../data/batches";
import { LabelSwatch } from "../ui/chips";
import { ChooserPopup, type ChooserItemPresentation } from "../ui/ChooserPopup";
import {
  isQuickFilterSelected,
  quickFilters,
  REVIEW_OPTIONS,
  reviewText,
  searchHistoryText,
  SORT_OPTIONS,
  sortText,
  STATE_OPTIONS,
  stateText,
  withQuery,
  type ChipOption,
} from "./model";
import styles from "./List.module.css";

type Apply = (v: PrSearchValue) => void;

// ---------------------------------------------------------------------------
// Search field

function SearchTextField({ search, apply }: { search: PrSearchValue; apply: Apply }) {
  const applied = search.searchQuery ?? "";
  const [text, setText] = useState(applied);
  // The text follows the search when it changes elsewhere (history, Quick Filters, Clear).
  const [shown, setShown] = useState(applied);
  if (shown !== applied) {
    setShown(applied);
    setText(applied);
  }
  const field = useRef<HTMLDivElement>(null);
  const showHistory = () => {
    const r = field.current?.getBoundingClientRect();
    const history = loadSearchHistory();
    const items: MenuItem[] = history.length
      ? history.map((v, i) => ({
          id: `h${i}`,
          label: searchHistoryText(v),
          verbatim: true,
          run: () => apply(v),
        }))
      : [{ label: "Nothing to show", disabled: true }];
    showContextMenu({ x: (r?.left ?? 0) + 2, y: r?.bottom ?? 0 }, items);
  };
  return (
    <div ref={field}>
      <SearchField
        value={text}
        onChange={setText}
        onHistory={showHistory}
        clearable={false}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          apply(withQuery(search, text));
        }}
        aria-label="Search pull requests"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick Filters

function QuickFilterButton({ search, apply, login }: { search: PrSearchValue; apply: Apply; login: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const count = filterCount(search);
  const items: MenuItem[] = [
    { kind: "header", label: "Quick Filters" },
    ...quickFilters(login).map((q): MenuItem => ({
      id: q.id,
      label: q.title,
      checked: isQuickFilterSelected(search, q),
      run: () => apply(q.filter),
    })),
    { kind: "separator" },
    ...(count > 0 ? [{ id: "clear", label: tx`Clear ${count} Filters`, verbatim: true, run: () => apply({}) }] : []),
  ];
  return (
    <span ref={anchor} className={styles.quickFilter}>
      <IconButton icon="filter" title="Quick Filters" pressed={open} onClick={() => setOpen((o) => !o)} />
      {count > 0 && <span className={styles.badge} aria-hidden data-badge />}
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} items={items} aria-label="Quick Filters" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Chips

type PopupRender = (anchor: HTMLElement, done: (value: string | undefined) => void) => ReactNode;

function FilterChip({
  title,
  value,
  onChange,
  popup,
}: {
  title: string;
  /** The chip's text for the current value; undefined when unset. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  popup: PopupRender;
}) {
  const t = useTx();
  const chip = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const set = value !== undefined;
  const name = t(title);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onChange(undefined);
    }
  };
  return (
    <span ref={chip} className={styles.chip} data-set={set || undefined} data-tooltip={title}>
      <button
        type="button"
        className={styles.chipMain}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={() => setAnchor(chip.current)}
        onKeyDown={onKeyDown}
      >
        <span className={styles.chipText}>{set ? value : name}</span>
        {!set && <Icon name="chevron-down" size={12} className={styles.chipChevron} />}
      </button>
      {set && (
        <button
          type="button"
          className={styles.chipReset}
          aria-label={t`Reset ${name}`}
          onClick={() => onChange(undefined)}
          onKeyDown={onKeyDown}
          tabIndex={-1}
        >
          <Icon name="close" size={12} />
        </button>
      )}
      {anchor &&
        popup(anchor, (v) => {
          setAnchor(null);
          onChange(v);
        })}
    </span>
  );
}

const ROW = 28;
/** List popups show up to 7 rows under the search field. */
const optionsHeight = (n: number) => 44 + Math.min(n, 7) * ROW + 4;

/** `ChooserPopupUtil.showChooserPopup` / `showChooserPopupWithIncrementalLoading`: the chosen value, or undefined when closed without choosing. */
function Chooser<T>({
  anchor,
  done,
  title,
  items,
  getKey,
  present,
  state,
  height,
}: {
  anchor: HTMLElement;
  done: (item: T | undefined) => void;
  title: string;
  items: readonly T[];
  getKey: (item: T) => string;
  present: (item: T) => ChooserItemPresentation;
  state?: Pick<BatchesState<T>, "loading" | "error">;
  height?: number;
}) {
  const chosen = useRef<{ item: T } | null>(null);
  return (
    <ChooserPopup<T>
      mode="single"
      anchor={anchor}
      items={items}
      getKey={getKey}
      present={present}
      loading={state?.loading}
      error={state?.error}
      height={height}
      aria-label={title}
      onChoose={(item) => (chosen.current = { item })}
      onClose={() => done(chosen.current?.item)}
    />
  );
}

function OptionChip<V extends string>({
  title,
  options,
  value,
  text,
  onChange,
}: {
  title: string;
  options: readonly ChipOption<V>[];
  value: V | undefined;
  text: (v: V) => string;
  onChange: (v: V | undefined) => void;
}) {
  return (
    <FilterChip
      title={title}
      value={value === undefined ? undefined : text(value)}
      onChange={(v) => onChange(v as V | undefined)}
      popup={(anchor, done) => (
        <Chooser<ChipOption<V>>
          anchor={anchor}
          title={title}
          items={options}
          getKey={(o) => o.value}
          present={(o) => ({ text: tx(o.label ?? o.text) })}
          height={optionsHeight(options.length)}
          done={(o) => done(o?.value)}
        />
      )}
    />
  );
}

const presentUser = (u: GHUser): ChooserItemPresentation => ({ text: u.login, detail: u.name, avatarUrl: u.avatarUrl });
const userKey = (u: GHUser) => u.id || u.login;

function AuthorChooser({ anchor, done }: { anchor: HTMLElement; done: (v: string | undefined) => void }) {
  const authors = useAuthorCandidates();
  return (
    <Chooser<GHUser>
      anchor={anchor}
      title="Author"
      items={authors.items}
      state={authors}
      getKey={userKey}
      present={presentUser}
      done={(u) => done(u?.login)}
    />
  );
}

function AssigneeChooser({ anchor, done }: { anchor: HTMLElement; done: (v: string | undefined) => void }) {
  const assignees = useRepositoryList("assignees");
  return (
    <Chooser<GHUser>
      anchor={anchor}
      title="Assignee"
      items={assignees.items}
      state={assignees}
      getKey={userKey}
      present={presentUser}
      done={(u) => done(u?.login)}
    />
  );
}

function LabelChooser({ anchor, done }: { anchor: HTMLElement; done: (v: string | undefined) => void }) {
  const labels = useRepositoryList("labels");
  return (
    <Chooser<GHLabel>
      anchor={anchor}
      title="Label"
      items={labels.items}
      state={labels}
      getKey={(l) => l.id || l.name}
      present={(l) => ({ text: l.name, leading: <LabelSwatch label={l} /> })}
      done={(l) => done(l?.name)}
    />
  );
}

/** The chips' row: scrolls horizontally, fading the clipped edges (`GradientViewport`). */
function ChipsRow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<"left" | "right" | "both" | undefined>(undefined);
  const update = () => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 0;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade(left && right ? "both" : left ? "left" : right ? "right" : undefined);
  };
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={styles.chips}
      data-fade={fade}
      onScroll={update}
      onWheel={(e) => {
        // A vertical wheel scrolls the row sideways, as JBScrollPane's FORCE_HORIZONTAL_SCROLL.
        const el = ref.current;
        if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
      }}
      role="toolbar"
      aria-label="Filters"
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function SearchPanel({ search, apply, login }: { search: PrSearchValue; apply: Apply; login: string }) {
  const patch = (p: Partial<PrSearchValue>) => {
    const next: PrSearchValue = { ...search, ...p };
    for (const k of Object.keys(p) as (keyof PrSearchValue)[]) if (next[k] === undefined) delete next[k];
    apply(next);
  };
  return (
    <div className={styles.search}>
      <SearchTextField search={search} apply={apply} />
      <div className={styles.filterRow}>
        <QuickFilterButton search={search} apply={apply} login={login} />
        <ChipsRow>
          <OptionChip
            title="State"
            options={STATE_OPTIONS}
            value={search.state}
            text={stateText}
            onChange={(state) => patch({ state })}
          />
          <FilterChip
            title="Author"
            value={search.author}
            onChange={(author) => patch({ author })}
            popup={(anchor, done) => <AuthorChooser anchor={anchor} done={done} />}
          />
          <FilterChip
            title="Label"
            value={search.label}
            onChange={(label) => patch({ label })}
            popup={(anchor, done) => <LabelChooser anchor={anchor} done={done} />}
          />
          <FilterChip
            title="Assignee"
            value={search.assignee}
            onChange={(assignee) => patch({ assignee })}
            popup={(anchor, done) => <AssigneeChooser anchor={anchor} done={done} />}
          />
          <OptionChip
            title="Review"
            options={REVIEW_OPTIONS}
            value={search.reviewState}
            text={reviewText}
            onChange={(reviewState) => patch({ reviewState })}
          />
          <OptionChip
            title="Sort"
            options={SORT_OPTIONS}
            value={search.sort}
            text={sortText}
            onChange={(sort) => patch({ sort })}
          />
        </ChipsRow>
      </div>
    </div>
  );
}
