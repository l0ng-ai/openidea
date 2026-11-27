/**
 * The Push dialog's target branch field. Free text stays allowed (a name the remote
 * does not have yet is created by the push), and what is typed is completed from the
 * branches the chosen remote already has, so an existing remote branch need not be
 * spelled out in full.
 */
import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { HighlightedText, Icon, Input, List, Popup, fuzzyMatch, listNavigate } from "@/ui";
import { useRowHeight } from "@/ui/density";
import { useTx } from "@/platform/i18n";
import { recentPushTargets } from "./pushHistory";
import styles from "./common.module.css";

export interface RemoteBranchSuggestion {
  /** Branch name on the remote, without the remote's prefix. */
  name: string;
  /** Highlighted characters of `name`. */
  match: number[] | null;
  recent: boolean;
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

/** How closely `match` fits: a prefix, then a contiguous run, then anything looser. */
function tier(match: number[]): number {
  const contiguous = match.every((at, i) => i === 0 || at === match[i - 1]! + 1);
  return contiguous ? (match[0] === 0 ? 0 : 1) : 2;
}

/**
 * Branches of `remote` that fuzzy-match `query`: names starting with it first, then the other
 * contiguous matches, then the looser ones, each group in the store's order (most recently used
 * first). The remote prefix may be typed along with the name (`origin/feat`), as git prints refs
 * that way.
 */
export function suggestRemoteBranches(
  names: readonly string[],
  query: string,
  remote: string | null,
  recent: readonly string[] = [],
  browse = false,
): RemoteBranchSuggestion[] {
  const q = stripRemotePrefix(query.trim(), remote);
  const matches: RemoteBranchSuggestion[] = [];
  const seen = new Set<string>();
  for (const name of recent) {
    if (seen.has(name)) continue;
    seen.add(name);
    const match = q ? fuzzyMatch(name, q) : [];
    if (match) matches.push({ name, match, recent: true });
  }
  if (!browse && !query.trim()) return matches;
  const branches: Array<RemoteBranchSuggestion & { tier: number }> = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const match = q ? fuzzyMatch(name, q) : [];
    if (match) branches.push({ name, match, recent: false, tier: tier(match) });
  }
  return matches.concat(
    branches.sort((a, b) => a.tier - b.tier).map(({ name, match, recent }) => ({ name, match, recent })),
  );
}

export function TargetBranchInput({
  value,
  onChange,
  branches,
  remote,
  repo = null,
  source = null,
  error,
  label = "Target branch",
  className = styles.targetInput,
  style,
  changed,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Branch names of `remote`, without its prefix. */
  branches: readonly string[];
  remote: string | null;
  repo?: string | null;
  source?: string | null;
  error?: string | null;
  label?: string;
  className?: string;
  style?: CSSProperties;
  changed?: boolean;
  onSubmit?: () => void;
}) {
  const tx = useTx();
  const id = useId();
  const rowHeight = useRowHeight(ROW_HEIGHT);
  const input = useRef<HTMLInputElement>(null);
  const scope = useMemo(() => ({ repo, source, remote }), [repo, source, remote]);
  const [lastCompletion, setCompletion] = useState<{ scope: typeof scope; browse: boolean; recent: string[] } | null>(
    null,
  );
  const completion = lastCompletion?.scope === scope ? lastCompletion : null;
  // No row is chosen until the user moves in the list: Enter keeps pushing the typed name.
  const [active, setActive] = useState(-1);
  const suggestions = useMemo(
    () =>
      completion
        ? suggestRemoteBranches(branches, completion.browse ? "" : value, remote, completion.recent, completion.browse)
        : [],
    [branches, completion, value, remote],
  );
  const close = () => {
    setCompletion(null);
    setActive(-1);
  };
  const choose = (suggestion: RemoteBranchSuggestion | undefined) => {
    if (!suggestion) return;
    onChange(suggestion.name);
    close();
    input.current?.focus();
  };
  const shown = !!completion && (completion.browse || !!value.trim() || suggestions.length > 0);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      if (shown && suggestions[active]) {
        e.preventDefault();
        e.stopPropagation();
        choose(suggestions[active]);
      } else if (onSubmit) {
        e.preventDefault();
        onSubmit();
      }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const recent = shown ? completion.recent : recentPushTargets(repo, source, remote);
    const items = shown ? suggestions : suggestRemoteBranches(branches, "", remote, recent, true);
    const previous = shown ? active : -1;
    const next = listNavigate(e.key, { items, active: previous, wrap: true });
    if (next === null || next === previous) return;
    e.preventDefault();
    if (!shown) setCompletion({ scope, browse: true, recent });
    setActive(next);
  };
  const recentLabel = tx("Recently pushed");
  const rows = suggestions.length ? Math.min(MAX_ROWS, Math.max(MIN_ROWS, suggestions.length)) : EMPTY_ROWS;
  return (
    <>
      <Input
        ref={input}
        mono
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
        aria-activedescendant={shown && suggestions[active] ? `${id}-${active}` : undefined}
        value={value}
        invalid={!!error}
        title={error ? tx(error) : undefined}
        className={className}
        style={style}
        data-changed={changed || undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(-1);
          setCompletion({
            scope,
            browse: false,
            recent: completion?.recent ?? recentPushTargets(repo, source, remote),
          });
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      <Popup
        open={shown}
        anchor={input}
        onClose={close}
        autoFocus={false}
        restoreFocus={false}
        role="presentation"
        className={styles.targetPopup}
      >
        {/* Sizes the popup to its widest row; the rows themselves are out of flow in the list. */}
        <div className={styles.targetSizer} aria-hidden>
          {suggestions.map((s) => (
            <span key={s.name}>
              {s.name}
              {s.recent && <span className={styles.targetRecent}>{recentLabel}</span>}
            </span>
          ))}
        </div>
        <div className={styles.targetListWrap} style={{ height: rows * rowHeight + LIST_PADDING }}>
          <List
            id={id}
            items={suggestions}
            getKey={(s) => s.name}
            activeIndex={active}
            onActiveChange={setActive}
            onActivate={(s) => choose(s)}
            focusable={false}
            hoverSelects
            rowHeight={rowHeight}
            aria-label={tx("Remote branches")}
            className={styles.targetList}
            empty={<span className={styles.hint}>{tx("No matching remote branches")}</span>}
            renderItem={(s, state) => (
              <span className={styles.targetRow} title={s.name}>
                <Icon name={s.recent ? "history" : "branch"} size={14} className={styles.targetIcon} />
                <HighlightedText
                  className={styles.targetName}
                  text={s.name}
                  indices={s.match}
                  tone={state.active ? "accent" : "strong"}
                />
                {s.recent && <span className={styles.targetRecent}>{recentLabel}</span>}
              </span>
            )}
          />
        </div>
      </Popup>
    </>
  );
}
