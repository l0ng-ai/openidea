/**
 * "Changes from {n} commits" (`CodeReviewDetailsCommitsComponentFactory`): the bold label,
 * the commit dropdown link (the selected commit's hash, else "{n} commits"; disabled with
 * one commit), its popup ("All commits (n)", a separator, then every commit with its
 * author and date, filtered by the search field) and the next / previous arrows. Below the
 * row, the selected commit's info block with Show / Hide details
 * (`CodeReviewDetailsCommitInfoComponentFactory`).
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import {
  HighlightedText,
  Icon,
  IconButton,
  List,
  Popup,
  SearchField,
  fuzzyMatch,
  listNavigate,
  T,
  type PopupAnchor,
} from "@/ui";
import { useTx } from "@/platform/i18n";
import type { GHPullRequestCommit } from "../api/types";
import { GHOST_USER } from "../data/model";
import { prettyDateTime } from "../ui/prettyDate";
import { commitsTitle, stepCommit } from "./model";
import styles from "./Details.module.css";

/** `createCommitsPopupPresenter`: headline, body, author (the ghost user when unknown) and date. */
function presentation(c: GHPullRequestCommit) {
  const user = c.commit.author?.user ?? GHOST_USER;
  return {
    title: c.commit.messageHeadline,
    description: c.commit.messageBody,
    author: user.name || user.login,
    date: prettyDateTime(c.commit.committedDate),
  };
}

export function CommitPicker({
  commits,
  selected,
  onSelect,
}: {
  commits: readonly GHPullRequestCommit[];
  /** Index of the selected commit; -1 for all. */
  selected: number;
  onSelect: (index: number) => void;
}) {
  const tx = useTx();
  const link = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const commit = commits[selected];
  const arrows = commits.length > 1 && selected >= 0;
  const longest = Math.max(0, ...commits.map((c) => c.commit.abbreviatedOid.length));
  const next = stepCommit(selected, commits.length, 1);
  const previous = stepCommit(selected, commits.length, -1);
  return (
    <div className={styles.commits}>
      <span className={styles.bold}>
        <T>{commitsTitle(commits.length)}</T>
      </span>
      <button
        ref={link}
        type="button"
        className={clsx(styles.link, styles.dropdownLink)}
        disabled={commits.length <= 1}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        // The link is as wide as the longest hash once one is shown, so the arrows do not move.
        style={commit ? { minWidth: `calc(${longest}ch + 20px)` } : undefined}
      >
        <span>{commit ? commit.commit.abbreviatedOid : tx`${commits.length} commits`}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {arrows && (
        <>
          <IconButton
            icon="chevron-down"
            size="small"
            title="Next Commit"
            disabled={next === null}
            onClick={() => next !== null && onSelect(next)}
          />
          <IconButton
            icon="chevron-up"
            size="small"
            title="Previous Commit"
            disabled={previous === null}
            onClick={() => previous !== null && onSelect(previous)}
          />
        </>
      )}
      {open && (
        <CommitsPopup
          anchor={link}
          commits={commits}
          selected={selected}
          onChoose={onSelect}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

type Row = { kind: "all" } | { kind: "separator" } | { kind: "commit"; index: number; match: number[] | null };

function CommitsPopup(props: {
  anchor: PopupAnchor;
  commits: readonly GHPullRequestCommit[];
  selected: number;
  onChoose: (index: number) => void;
  onClose: () => void;
}) {
  const { commits, selected } = props;
  const tx = useTx();
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const allText = tx`All commits (${commits.length})`;
  const rows = useMemo((): Row[] => {
    const q = filter.trim();
    const out: Row[] = [];
    if (!q || fuzzyMatch(allText, q)) out.push({ kind: "all" }, { kind: "separator" });
    commits.forEach((c, index) => {
      const match = q ? fuzzyMatch(c.commit.messageHeadline, q) : null;
      if (!q || match) out.push({ kind: "commit", index, match });
    });
    return out;
  }, [commits, filter, allText]);
  const isSection = (r: Row) => r.kind === "separator";
  const current = Math.min(active, rows.length - 1);
  const choose = (r: Row | undefined) => {
    if (!r || r.kind === "separator") return;
    props.onChoose(r.kind === "all" ? -1 : r.index);
    props.onClose();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const n = listNavigate(e.key, { items: rows, active: current, isSection, wrap: true, pageSize: 7 });
    if (n !== null && e.key !== "Home" && e.key !== "End") {
      e.preventDefault();
      setActive(n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(rows[current]);
    }
  };
  return (
    <Popup
      open
      anchor={props.anchor}
      placement="bottom-start"
      onClose={props.onClose}
      aria-label={tx("Commits")}
      className={styles.commitsPopup}
    >
      <div className={styles.popupSearch}>
        <SearchField
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search commits"
          aria-label={tx("Search commits")}
          data-autofocus
        />
      </div>
      <List
        items={rows}
        getKey={(r, i) => (r.kind === "commit" ? `c:${r.index}` : `${r.kind}:${i}`)}
        isSection={isSection}
        renderSection={() => <div className={styles.popupSeparator} />}
        sectionHeight={9}
        activeIndex={current}
        onActiveChange={setActive}
        onActivate={(r) => choose(r)}
        focusable={false}
        hoverSelects
        rowHeight={52}
        className={styles.commitsList}
        aria-label={tx("Commits")}
        renderItem={(r, state) => {
          if (r.kind !== "commit")
            return (
              <div className={clsx(styles.commitRow, styles.allCommitsRow)} data-active={state.active || undefined}>
                <span className={styles.check}>{selected < 0 && <Icon name="check" size={16} />}</span>
                <span>{allText}</span>
              </div>
            );
          const p = presentation(commits[r.index]!);
          return (
            <div className={styles.commitRow} data-active={state.active || undefined}>
              <span className={styles.check}>{selected === r.index && <Icon name="check" size={16} />}</span>
              <span className={styles.commitText}>
                <HighlightedText className={styles.ellipsis} text={p.title} indices={r.match} />
                <span className={clsx(styles.secondary, styles.ellipsis)}>
                  {p.author}, {p.date}
                </span>
              </span>
            </div>
          );
        }}
      />
    </Popup>
  );
}

/** The selected commit: its headline (one line), Show / Hide details, then its body and "author, date". */
export function CommitInfo({ commit }: { commit: GHPullRequestCommit }) {
  const [detailed, setDetailed] = useState(false);
  const p = presentation(commit);
  return (
    <div className={styles.commitInfo}>
      <div className={styles.commitInfoTop}>
        <span className={clsx(styles.commitInfoTitle, !detailed && styles.ellipsis)} title={p.title}>
          {p.title}
        </span>
        <button type="button" className={styles.link} onClick={() => setDetailed(!detailed)}>
          <T>{detailed ? "Hide details" : "Show details"}</T>
        </button>
      </div>
      {detailed && (
        <>
          {p.description && <div className={styles.commitDescription}>{p.description}</div>}
          <div className={styles.secondary}>
            {p.author}, {p.date}
          </div>
        </>
      )}
    </div>
  );
}
