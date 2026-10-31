/**
 * The merge direction (git4idea's `MergeDirectionComponentFactory`): two link-style
 * dropdowns, the base and the head, joined by "←". The base lists the branches of the
 * connected repository's remote; the head lists the local branches and the branches of
 * the chosen repository (the project's GitHub remotes and forks).
 */
import { useMemo, useState, type KeyboardEvent } from "react";
import { HighlightedText, Icon, List, Popup, SearchField, Select, T, fuzzyMatch, listNavigate } from "@/ui";
import { useTx } from "@/platform/i18n";
import { nameWithOwner, sameRepository, useGhRepository, type GHRemote } from "../data/repository";
import { ChooserPopup } from "../ui/ChooserPopup";
import {
  baseText,
  headBranchName,
  headText,
  localBranchesOf,
  remoteBranchesOf,
  sameHead,
  type HeadBranch,
  type RemoteBranchRef,
} from "./model";
import { setBaseBranch, setHead, useCreatePr } from "./store";
import styles from "./Create.module.css";

function DropDownLink(props: { text: string | null; label: string; onClick: (el: HTMLElement) => void }) {
  const tx = useTx();
  return (
    <button
      type="button"
      className={styles.link}
      aria-label={tx(props.label)}
      title={props.text ?? undefined}
      onClick={(e) => props.onClick(e.currentTarget)}
    >
      <span className={styles.linkText}>{props.text ?? tx("Select…")}</span>
      <Icon name="chevron-down" size={12} />
    </button>
  );
}

export function DirectionSelector() {
  const direction = useCreatePr((s) => s.direction);
  const branches = useCreatePr((s) => s.branches);
  const [open, setOpen] = useState<{ which: "base" | "head"; anchor: HTMLElement } | null>(null);
  const baseBranches = useMemo(
    () => (direction ? remoteBranchesOf(branches, direction.baseRepo.remote) : []),
    [branches, direction],
  );
  if (!direction) return null;
  return (
    <div className={styles.direction}>
      <DropDownLink
        text={baseText(direction)}
        label="Base branch"
        onClick={(anchor) => setOpen({ which: "base", anchor })}
      />
      <span className={styles.arrow} aria-hidden>
        ←
      </span>
      <DropDownLink
        text={headText(direction)}
        label="Head branch"
        onClick={(anchor) => setOpen({ which: "head", anchor })}
      />
      {open?.which === "base" && (
        <ChooserPopup<RemoteBranchRef>
          mode="single"
          anchor={open.anchor}
          items={baseBranches}
          getKey={(b) => b.name}
          present={(b) => ({ text: b.name, icon: "branch-label" })}
          placeholder="Search branches"
          aria-label="Base branch"
          onChoose={setBaseBranch}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.which === "head" && (
        <HeadPopup
          anchor={open.anchor}
          initialRepo={direction.headRepo ?? direction.baseRepo}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

type HeadRow = { section: string } | { branch: HeadBranch; text: string; match: number[] | null };

/** The head: the repository (several GitHub remotes only), then its branches, local first. */
function HeadPopup(props: { anchor: HTMLElement; initialRepo: GHRemote; onClose: () => void }) {
  const tx = useTx();
  const remotes = useGhRepository((s) => s.remotes);
  const branches = useCreatePr((s) => s.branches);
  const current = useCreatePr((s) => s.direction?.headBranch ?? null);
  const [repo, setRepo] = useState(props.initialRepo);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(1);
  const rows = useMemo(() => {
    const q = filter.trim();
    const section = (title: string, list: HeadBranch[]): HeadRow[] => {
      const items = list.flatMap((branch) => {
        const text = headBranchName(branch);
        const match = q ? fuzzyMatch(text, q) : null;
        return q && !match ? [] : [{ branch, text, match }];
      });
      return items.length ? [{ section: title }, ...items] : [];
    };
    const remote = remoteBranchesOf(branches, repo.remote).map((b): HeadBranch => ({ kind: "remote", ...b }));
    return [...section(tx("Local"), localBranchesOf(branches)), ...section(tx("Remote"), remote)];
  }, [branches, repo, filter, tx]);
  const isSection = (r: HeadRow) => "section" in r;
  const index = Math.min(Math.max(active, 0), rows.length - 1);
  const choose = (r: HeadRow | undefined) => {
    if (!r || "section" in r) return;
    setHead(repo, r.branch);
    props.onClose();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const next = listNavigate(e.key, { items: rows, active: index, wrap: true, pageSize: 7, isSection });
    if (next !== null && e.key !== "Home" && e.key !== "End") {
      e.preventDefault();
      setActive(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(rows[index]);
    }
  };
  return (
    <Popup
      open
      anchor={props.anchor}
      placement="bottom-start"
      offset={4}
      onClose={props.onClose}
      role="dialog"
      aria-label={tx("Head branch")}
      className={styles.headPopup}
    >
      {remotes.length > 1 && (
        <div className={styles.headRepo}>
          <span className={styles.headRepoLabel}>
            <T>Repository:</T>
          </span>
          <Select
            value={nameWithOwner(repo)}
            options={remotes.map((r) => ({ value: nameWithOwner(r), label: `${nameWithOwner(r)} (${r.remote})` }))}
            onChange={(v) => {
              const next = remotes.find((r) => nameWithOwner(r) === v);
              if (next && !sameRepository(next, repo)) setRepo(next);
            }}
            aria-label="Head repository"
          />
        </div>
      )}
      <div className={styles.headSearch}>
        <SearchField
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setActive(1);
          }}
          onKeyDown={onKeyDown}
          placeholder={tx("Search branches")}
          aria-label="Search branches"
          data-autofocus
        />
      </div>
      <List
        items={rows}
        getKey={(r) => ("section" in r ? `s:${r.section}` : `${r.branch.kind}:${r.text}`)}
        isSection={isSection}
        renderSection={(r) => <div className={styles.headSection}>{"section" in r ? r.section : null}</div>}
        sectionHeight={22}
        activeIndex={index}
        onActiveChange={setActive}
        onActivate={(r) => choose(r)}
        focusable={false}
        hoverSelects
        rowHeight={24}
        className={styles.headList}
        aria-label="Branches"
        empty={<div className={styles.hint}>{tx("Nothing to show")}</div>}
        renderItem={(r, state) =>
          "section" in r ? null : (
            <div className={styles.headRow} data-active={state.active || undefined}>
              <Icon name={sameHead(r.branch, current) ? "current-branch-label" : "branch-label"} size={16} />
              <HighlightedText text={r.text} indices={r.match} />
            </div>
          )
        }
      />
    </Popup>
  );
}
