/**
 * The Push dialog's target branch field. Free text stays allowed (a name the remote
 * does not have yet is created by the push), and what is typed is completed from the
 * branches the chosen remote already has, so an existing remote branch need not be
 * spelled out in full.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { HighlightedText, Icon, Input, List, Popup, fuzzyMatch, listNavigate } from "@/ui";
import { useTx } from "@/platform/i18n";
import styles from "./common.module.css";

export interface RemoteBranchSuggestion {
  /** Branch name on the remote, without the remote's prefix. */
  name: string;
  /** Highlighted characters of `name`. */
  match: number[] | null;
}

const ROW_HEIGHT = 22;
const MIN_ROWS = 3;
const MAX_ROWS = 10;
const EMPTY_ROWS = 2;
/** Padding above and below the rows (`.targetListWrap`). */
const LIST_PADDING = 8;

/**
 * `name` without a leading `<remote>/`, for a field that accepts the prefix git prints
 * (`origin/feat`) but pushes the branch name itself (`feat`).
 */
export function stripRemotePrefix(name: string, remote: string | null): string {
  if (!remote) return name;
  const prefix = `${remote}/`;
  return name.toLowerCase().startsWith(prefix.toLowerCase()) ? name.slice(prefix.length) : name;
}

/**
 * Branches of `remote` that fuzzy-match `query`, most recently used first (the order
 * of the store's branches). The remote prefix may be typed along with the name
 * (`origin/feat`), as git prints refs that way.
 */
export function suggestRemoteBranches(
  names: readonly string[],
  query: string,
  remote: string | null,
): RemoteBranchSuggestion[] {
  const q = query.trim();
  if (!q) return [];
  const prefix = remote ? `${remote}/` : null;
  const withoutPrefix = prefix && q.toLowerCase().startsWith(prefix.toLowerCase()) ? q.slice(prefix.length) : null;
  const out: RemoteBranchSuggestion[] = [];
  for (const name of names) {
    const match =
      (withoutPrefix ? null : fuzzyMatch(name, q)) ?? (withoutPrefix ? fuzzyMatch(name, withoutPrefix) : null);
    if (match) out.push({ name, match });
  }
  return out;
}

export function TargetBranchInput({
  value,
  onChange,
  branches,
  remote,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Branch names of `remote`, without its prefix. */
  branches: readonly string[];
  remote: string | null;
}) {
  const tx = useTx();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // No row is chosen until the user moves in the list: Enter keeps pushing the typed name.
  const [active, setActive] = useState(-1);
  const suggestions = useMemo(() => suggestRemoteBranches(branches, value, remote), [branches, value, remote]);
  const choose = (suggestion: RemoteBranchSuggestion | undefined) => {
    if (!suggestion) return;
    onChange(suggestion.name);
    setOpen(false);
    setActive(-1);
    input.current?.focus();
  };
  const shown = open && !!value.trim();
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && shown && active >= 0 && suggestions[active]) {
      // Choose the branch instead of running the dialog's default button.
      e.preventDefault();
      e.stopPropagation();
      choose(suggestions[active]);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const next = listNavigate(e.key, { items: suggestions, active, wrap: true });
    if (next === null || next === active) return;
    e.preventDefault();
    setOpen(true);
    setActive(next);
  };
  const rows = suggestions.length ? Math.min(MAX_ROWS, Math.max(MIN_ROWS, suggestions.length)) : EMPTY_ROWS;
  return (
    <>
      <Input
        ref={input}
        mono
        role="combobox"
        aria-label="Target branch"
        aria-autocomplete="list"
        aria-expanded={shown}
        value={value}
        className={styles.targetInput}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      <Popup
        open={shown}
        anchor={input}
        onClose={() => setOpen(false)}
        autoFocus={false}
        restoreFocus={false}
        role="presentation"
        className={styles.targetPopup}
      >
        {/* Sizes the popup to its widest row; the rows themselves are out of flow in the list. */}
        <div className={styles.targetSizer} aria-hidden>
          {suggestions.map((s) => (
            <span key={s.name}>{s.name}</span>
          ))}
        </div>
        <div className={styles.targetListWrap} style={{ height: rows * ROW_HEIGHT + LIST_PADDING }}>
          <List
            items={suggestions}
            getKey={(s) => s.name}
            activeIndex={active}
            onActiveChange={setActive}
            onActivate={(s) => choose(s)}
            focusable={false}
            hoverSelects
            rowHeight={ROW_HEIGHT}
            aria-label={tx("Remote branches")}
            className={styles.targetList}
            empty={<span className={styles.hint}>{tx("No matching remote branches")}</span>}
            renderItem={(s, state) => (
              <span className={styles.targetRow} title={s.name}>
                <Icon name="branch" size={14} className={styles.targetIcon} />
                <HighlightedText
                  className={styles.targetName}
                  text={s.name}
                  indices={s.match}
                  tone={state.active ? "accent" : "strong"}
                />
              </span>
            )}
          />
        </div>
      </Popup>
    </>
  );
}
