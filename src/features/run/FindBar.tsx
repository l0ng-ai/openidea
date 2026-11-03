/** ⌘F in the Run console: the IDEA find bar (Match Case / Words / Regex, n/m, previous/next). */
import { type KeyboardEvent, type RefObject } from "react";
import clsx from "clsx";
import { IconButton, SearchField } from "@/ui";
import { hasPrimaryModifier } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import type { FindOptions } from "./find";
import styles from "./Run.module.css";

export interface ConsoleFindBarProps {
  query: string;
  onChange: (query: string) => void;
  options: FindOptions;
  onOptionsChange: (options: FindOptions) => void;
  /** Number of matches. */
  count: number;
  /** Zero-based current match; -1 when there is none. */
  active: number;
  /** More matches exist than were collected. */
  overflow: boolean;
  /** The query is an invalid regular expression. */
  invalid: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function ConsoleFindBar({
  query,
  onChange,
  options,
  onOptionsChange,
  count,
  active,
  overflow,
  invalid,
  inputRef,
  onNext,
  onPrevious,
  onClose,
}: ConsoleFindBarProps) {
  const none = !!query && !invalid && count === 0;
  const counter = invalid
    ? "Bad regex"
    : !query
      ? ""
      : count === 0
        ? "0 results"
        : `${active + 1}/${count}${overflow ? "+" : ""}`;
  const toggle = (key: keyof FindOptions) => onOptionsChange({ ...options, [key]: !options[key] });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) onPrevious();
      else onNext();
    } else if (e.key === "F3" || (hasPrimaryModifier(e) && e.key.toLowerCase() === "g")) {
      e.preventDefault();
      if (e.shiftKey) onPrevious();
      else onNext();
    } else if (hasPrimaryModifier(e) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const key =
        e.code === "KeyC" ? "caseSensitive" : e.code === "KeyW" ? "wholeWord" : e.code === "KeyX" ? "regex" : null;
      if (key) {
        e.preventDefault();
        toggle(key);
      }
    }
  };

  return (
    <div
      className={styles.find}
      role="search"
      aria-label={tx("Find in console")}
      data-run-find=""
      onKeyDown={onKeyDown}
    >
      <SearchField
        ref={inputRef}
        className={styles.findField}
        value={query}
        onChange={onChange}
        placeholder="Find in console"
        aria-label="Find in console"
        invalid={invalid || none}
        toggles={[
          {
            id: "case",
            icon: "case",
            title: "Match Case",
            shortcut: "⌥C",
            pressed: options.caseSensitive,
            onToggle: () => toggle("caseSensitive"),
          },
          {
            id: "word",
            icon: "word",
            title: "Words",
            shortcut: "⌥W",
            pressed: options.wholeWord,
            onToggle: () => toggle("wholeWord"),
          },
          {
            id: "regex",
            icon: "regex",
            title: "Regex",
            shortcut: "⌥X",
            pressed: options.regex,
            onToggle: () => toggle("regex"),
          },
        ]}
      />
      <span className={clsx(styles.findCount, (invalid || none) && styles.findCountNone)} aria-live="polite">
        {counter}
      </span>
      <IconButton
        icon="arrow-up"
        title="Previous Occurrence"
        shortcut="⇧↵"
        size="small"
        disabled={count === 0}
        onClick={onPrevious}
      />
      <IconButton
        icon="arrow-down"
        title="Next Occurrence"
        shortcut="↵"
        size="small"
        disabled={count === 0}
        onClick={onNext}
      />
      <span className={styles.findSpacer} />
      <IconButton icon="close" title="Close" shortcut="⎋" size="small" onClick={onClose} />
    </div>
  );
}
