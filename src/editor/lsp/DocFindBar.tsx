/** Find bar for the current page in the Documentation tool window. */
import type { KeyboardEvent, RefObject } from "react";
import clsx from "clsx";
import { IconButton } from "@/ui";
import { SearchField } from "@/ui/Input";
import { useTx } from "@/platform/i18n";
import { formatBinding } from "@/platform/keymap";
import styles from "./Popups.module.css";

export interface DocFindBarProps {
  query: string;
  onChange(query: string): void;
  count: number;
  /** Zero-based current match; -1 when there is none. */
  active: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onNext(): void;
  onPrevious(): void;
  onClose(): void;
}

export function DocFindBar({ query, onChange, count, active, inputRef, onNext, onPrevious, onClose }: DocFindBarProps) {
  const tx = useTx();
  const none = !!query && count === 0;
  const label = tx("Find in Documentation");
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter") {
      // Enter on a navigation or close button activates that button, not Find Next.
      if ((e.target as Element | null)?.closest?.("button")) return;
      e.preventDefault();
      if (e.shiftKey) onPrevious();
      else onNext();
    }
  };
  return (
    <div role="search" aria-label={label} data-doc-find="" className={styles.docFindBar} onKeyDown={onKeyDown}>
      <SearchField
        ref={inputRef}
        className={styles.docFindField}
        value={query}
        onChange={onChange}
        placeholder={label}
        aria-label={label}
        clearable={false}
        invalid={none}
      />
      <div className={styles.docFindActions}>
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={clsx(styles.docFindCount, none && styles.docFindCountNone)}
        >
          {!query ? "" : count ? `${active + 1}/${count}` : tx("No matches")}
        </span>
        <IconButton
          icon="arrow-up"
          title={tx("Previous Match")}
          shortcut={formatBinding("Shift+Enter")}
          size="small"
          disabled={count === 0}
          onClick={onPrevious}
        />
        <IconButton
          icon="arrow-down"
          title={tx("Next Match")}
          shortcut="↵"
          size="small"
          disabled={count === 0}
          onClick={onNext}
        />
      </div>
      <IconButton icon="close" title={tx("Close")} shortcut="⎋" size="small" onClick={onClose} />
    </div>
  );
}
