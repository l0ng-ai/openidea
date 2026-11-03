/**
 * IntelliJ's chooser popups (`ChooserPopupUtil`): a search field over a list whose rows
 * show an avatar / icon / colour swatch, a short text and a grey full text. Items may
 * arrive incrementally (`loading` paints a busy row). The filter matches the short and
 * full texts.
 *
 * - `single`: Enter / click chooses the item and closes (`onChoose`).
 * - `multi`: Enter / Space / click toggles the check mark; the popup stays open and
 *   reports the chosen items when it closes (`onClose(chosen)`), as the reviewer,
 *   assignee and label pickers apply their change on close. The items chosen when it
 *   opened are listed first, even before they load.
 *
 *   <ChooserPopup mode="multi" anchor={button} items={users.items} loading={users.loading}
 *     chosen={current} getKey={(u) => u.id} present={(u) => ({ text: u.login, detail: u.name,
 *     avatarUrl: u.avatarUrl })} onClose={(chosen) => chosen && apply(chosen)} />
 */
import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { Placement } from "@floating-ui/react-dom";
import {
  HighlightedText,
  Icon,
  List,
  Popup,
  SearchField,
  Spinner,
  fuzzyMatch,
  listNavigate,
  T,
  type PopupAnchor,
} from "@/ui";
import { useTx } from "@/platform/i18n";
import { Avatar, AVATAR_SIZE } from "./Avatar";
import styles from "./ui.module.css";

/** `PopupItemPresentation`: what a row shows. */
export interface ChooserItemPresentation {
  /** Short text (login, label name); matched by the filter. */
  text: string;
  /** Grey text after it (full name); also matched. */
  detail?: string | null;
  /** An avatar row (users, teams). */
  avatarUrl?: string | null;
  /** An icon name from `ui/icons`. */
  icon?: string;
  /** A leading element instead (a label's colour swatch). */
  leading?: ReactNode;
}

interface CommonProps<T> {
  anchor: PopupAnchor;
  items: readonly T[];
  getKey: (item: T) => string;
  present: (item: T) => ChooserItemPresentation;
  /** More items are still loading. */
  loading?: boolean;
  /** Loading failed ("Something went wrong" when there is no message). */
  error?: string | null;
  placeholder?: string;
  placement?: Placement;
  /** Initial size (IntelliJ: 250×300, resizable). */
  width?: number;
  height?: number;
  "aria-label": string;
}

export interface SingleChooserProps<T> extends CommonProps<T> {
  mode: "single";
  onChoose: (item: T) => void;
  onClose: () => void;
}

export interface MultiChooserProps<T> extends CommonProps<T> {
  mode: "multi";
  /** Chosen when the popup opens; listed first. */
  chosen: readonly T[];
  /** The chosen items when the popup closes (Escape included, as in IntelliJ). */
  onClose: (chosen: T[]) => void;
}

export type ChooserPopupProps<T> = SingleChooserProps<T> | MultiChooserProps<T>;

const ROW_HEIGHT = 28;

interface Row<T> {
  item: T;
  key: string;
  p: ChooserItemPresentation;
  textMatch: number[] | null;
  detailMatch: number[] | null;
}

/** Items to list: the initially chosen ones first, then the loaded ones (deduplicated by key). */
export function chooserItems<T>(chosenFirst: readonly T[], loaded: readonly T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of [...chosenFirst, ...loaded]) {
    const k = getKey(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

export function ChooserPopup<T>(props: ChooserPopupProps<T>) {
  const { anchor, items, getKey, present, loading, error, placement = "bottom-start" } = props;
  const tx = useTx();
  const multi = props.mode === "multi";
  const initialChosen = multi ? props.chosen : null;
  const [initial] = useState(() => initialChosen ?? []);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set((initialChosen ?? []).map(getKey)));
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);

  const all = useMemo(() => chooserItems(initial, items, getKey), [initial, items, getKey]);
  const rows = useMemo(() => {
    const q = filter.trim();
    return all.flatMap((item): Row<T>[] => {
      const p = present(item);
      if (!q) return [{ item, key: getKey(item), p, textMatch: null, detailMatch: null }];
      const textMatch = fuzzyMatch(p.text, q);
      const detailMatch = p.detail ? fuzzyMatch(p.detail, q) : null;
      return textMatch || detailMatch ? [{ item, key: getKey(item), p, textMatch, detailMatch }] : [];
    });
  }, [all, filter, present, getKey]);
  const current = Math.min(active, rows.length - 1);

  const close = () => {
    if (props.mode === "multi") props.onClose(all.filter((i) => chosen.has(getKey(i))));
    else props.onClose();
  };
  const activate = (row: Row<T> | undefined) => {
    if (!row) return;
    if (props.mode === "single") {
      props.onChoose(row.item);
      props.onClose();
      return;
    }
    setChosen((cur) => {
      const next = new Set(cur);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const next = listNavigate(e.key, { items: rows, active: current, wrap: true, pageSize: 7 });
    if (next !== null && e.key !== "Home" && e.key !== "End") {
      e.preventDefault();
      setActive(next);
    } else if (e.key === "Enter" || (multi && e.key === " " && !filter)) {
      e.preventDefault();
      activate(rows[current]);
    }
  };

  const status = error ? (
    <div className={`${styles.chooserStatus} ${styles.chooserError}`}>{error || tx("Something went wrong")}</div>
  ) : loading ? (
    <div className={styles.chooserStatus}>
      <Spinner size={12} />
      <T>Loading…</T>
    </div>
  ) : null;

  return (
    <Popup
      open
      anchor={anchor}
      placement={placement}
      offset={4}
      onClose={close}
      role="dialog"
      aria-label={props["aria-label"]}
      className={styles.chooser}
      style={
        {
          "--chooser-width": `${props.width ?? 250}px`,
          "--chooser-height": `${props.height ?? 300}px`,
        } as CSSProperties
      }
    >
      <div className={styles.chooserSearch}>
        <SearchField
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={props.placeholder}
          aria-label={props["aria-label"]}
          data-autofocus
        />
      </div>
      <List
        items={rows}
        getKey={(r) => r.key}
        activeIndex={current}
        onActiveChange={setActive}
        onActivate={(r) => activate(r)}
        focusable={false}
        hoverSelects
        rowHeight={ROW_HEIGHT}
        className={styles.chooserList}
        aria-label={props["aria-label"]}
        empty={loading || error ? null : <div className={styles.chooserEmpty}>{tx("Nothing to show")}</div>}
        renderItem={(r, state) => (
          <div className={styles.chooserRow} data-active={state.active || undefined}>
            {multi && (
              <span className={styles.chooserCheck} aria-hidden>
                {chosen.has(r.key) && <Icon name="check" size={16} />}
              </span>
            )}
            {r.p.leading ??
              (r.p.avatarUrl !== undefined ? (
                <Avatar url={r.p.avatarUrl} name={r.p.text} size={AVATAR_SIZE.BASE} title={null} />
              ) : r.p.icon ? (
                <Icon name={r.p.icon} size={16} />
              ) : null)}
            <HighlightedText className={styles.chooserText} text={r.p.text} indices={r.textMatch} />
            {r.p.detail && (
              <HighlightedText className={styles.chooserDetail} text={r.p.detail} indices={r.detailMatch} />
            )}
          </div>
        )}
      />
      {status}
    </Popup>
  );
}
