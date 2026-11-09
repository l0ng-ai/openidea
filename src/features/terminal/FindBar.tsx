/** ⌘F in the terminal: search the scrollback (xterm addon-search) with Match Case / Words / Regex. */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { IconButton, SearchField } from "@/ui";
import type { TerminalSearchOptions, TerminalSearchResult } from "./session";
import { activeSession } from "./store";
import styles from "./Terminal.module.css";
import { formatBinding, hasPrimaryModifier } from "@/platform/keymap";
import { tx } from "@/platform/i18n";

export const useTerminalFind = create<{ open: boolean; seq: number; query: string; options: TerminalSearchOptions }>(
  () => ({
    open: false,
    seq: 0,
    query: "",
    options: { caseSensitive: false, regex: false, wholeWord: false },
  }),
);

/** Opens (or refocuses) the find bar, seeding it with the terminal selection. */
export function openTerminalFind() {
  // While open, the terminal selection is the current match: keep the query.
  const selection = useTerminalFind.getState().open ? "" : activeSession()?.term.getSelection().trim();
  useTerminalFind.setState((s) => ({
    open: true,
    seq: s.seq + 1,
    query: selection && !selection.includes("\n") ? selection : s.query,
  }));
}

export function closeTerminalFind() {
  if (!useTerminalFind.getState().open) return;
  useTerminalFind.setState({ open: false });
  const session = activeSession();
  session?.clearSearch();
  session?.focus();
}

/** "3/12", "999+" style counter text. */
export function matchCounter(r: TerminalSearchResult | null, query: string): string {
  if (!query || !r) return "";
  if (r.count === 0) return "0 results";
  return r.index >= 0 ? `${r.index + 1}/${r.count}` : `${r.count}+`;
}

/** The last open request the find bar took focus for. */
let focusedSeq = 0;

export function TerminalFindBar({ sessionKey }: { sessionKey: string | null }) {
  const { open, seq, query, options } = useTerminalFind();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<TerminalSearchResult | null>(null);

  // Only an open request focuses the field: the bar also re-mounts when another
  // tab group becomes active, and must not take focus from its terminal then.
  useEffect(() => {
    if (!open || seq === focusedSeq) return;
    focusedSeq = seq;
    input.current?.focus();
    input.current?.select();
  }, [open, seq]);

  // Re-run the search on query / option / session changes.
  useEffect(() => {
    if (!open) return;
    const session = activeSession();
    if (!session) return;
    const off = session.onSearchResults(setResult);
    // Results arrive through the listener (clearing reports 0 results).
    if (query) session.find(query, options, "next", true);
    else session.clearSearch();
    return () => {
      off();
      session.clearSearch();
    };
  }, [open, query, options, sessionKey]);

  if (!open) return null;

  const find = (direction: "next" | "previous") => activeSession()?.find(query, options, direction);
  const toggle = (k: keyof TerminalSearchOptions) =>
    useTerminalFind.setState((s) => ({ options: { ...s.options, [k]: !s.options[k] } }));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeTerminalFind();
    } else if (e.key === "Enter") {
      e.preventDefault();
      find(e.shiftKey ? "previous" : "next");
    } else if (e.key === "F3" || (hasPrimaryModifier(e) && e.key.toLowerCase() === "g")) {
      e.preventDefault();
      find(e.shiftKey ? "previous" : "next");
    } else if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const k =
        e.code === "KeyC" ? "caseSensitive" : e.code === "KeyW" ? "wholeWord" : e.code === "KeyX" ? "regex" : null;
      if (k) {
        e.preventDefault();
        toggle(k);
      }
    }
  };
  const counter = matchCounter(result, query);
  const none = !!query && result?.count === 0;

  return (
    <div
      className={styles.find}
      role="search"
      aria-label={tx("Find in terminal")}
      data-terminal-find=""
      onKeyDown={onKeyDown}
    >
      <SearchField
        ref={input}
        className={styles.findField}
        value={query}
        onChange={(q) => useTerminalFind.setState({ query: q })}
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        invalid={none}
        toggles={[
          {
            id: "case",
            icon: "case",
            title: "Match Case",
            shortcut: formatBinding("Alt+C"),
            pressed: options.caseSensitive,
            onToggle: () => toggle("caseSensitive"),
          },
          {
            id: "word",
            icon: "word",
            title: "Words",
            shortcut: formatBinding("Alt+W"),
            pressed: options.wholeWord,
            onToggle: () => toggle("wholeWord"),
          },
          {
            id: "regex",
            icon: "regex",
            title: "Regex",
            shortcut: formatBinding("Alt+X"),
            pressed: options.regex,
            onToggle: () => toggle("regex"),
          },
        ]}
      />
      <span className={clsx(styles.findCount, none && styles.findCountNone)} aria-live="polite">
        {counter}
      </span>
      <IconButton
        icon="arrow-up"
        title="Previous Occurrence"
        shortcut={formatBinding("Shift+Enter")}
        size="small"
        disabled={!query}
        onClick={() => find("previous")}
      />
      <IconButton
        icon="arrow-down"
        title="Next Occurrence"
        shortcut="↵"
        size="small"
        disabled={!query}
        onClick={() => find("next")}
      />
      <span className={styles.findSpacer} />
      <IconButton icon="close" title="Close" shortcut="⎋" size="small" onClick={closeTerminalFind} />
    </div>
  );
}
