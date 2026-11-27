import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { HighlightedText, Icon, List, Popup, SearchField, fileIconName, listNavigate, T } from "@/ui";
import { chooserRows, type LanguageRow, type ScratchLanguage } from "./model";
import { closeChooser, rememberLanguage, useScratch } from "./store";
import { createScratch } from "./scratches";
import styles from "./ScratchChooser.module.css";

const isDivider = (row: LanguageRow | null) => row === null;

/** Overlay: IDEA's "New Scratch File" popup — searchable languages, recent first. */
export function ScratchChooserHost() {
  const languages = useScratch((s) => s.languages);
  const seq = useScratch((s) => s.seq);
  if (!languages) return null;
  return <ScratchChooser key={seq} languages={languages} />;
}

function ScratchChooser({ languages }: { languages: readonly ScratchLanguage[] }) {
  const recent = useScratch((s) => s.recent);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const rows = useMemo(() => {
    const options = chooserRows(languages, recent, filter);
    if (filter.trim()) return options;
    const firstOther = options.findIndex(({ lang }) => !recent.includes(lang.id));
    return firstOther > 0 ? [...options.slice(0, firstOther), null, ...options.slice(firstOther)] : options;
  }, [languages, recent, filter]);
  const current = Math.min(active, rows.length - 1);
  const anchor = useMemo(
    () => ({ getBoundingClientRect: () => new DOMRect(window.innerWidth / 2, window.innerHeight / 5, 0, 0) }),
    [],
  );

  const pick = (row: LanguageRow | null | undefined) => {
    if (!row) return;
    closeChooser();
    rememberLanguage(row.lang.id);
    void createScratch(row.lang);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const next = listNavigate(e.key === "Home" || e.key === "End" ? "" : e.key, {
      items: rows,
      active: current,
      isSection: isDivider,
      wrap: true,
    });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(rows[current]);
    }
  };

  return (
    <Popup
      open
      anchor={anchor}
      placement="bottom"
      onClose={closeChooser}
      role="dialog"
      aria-label="New Scratch File"
      className={styles.popup}
    >
      <div className={styles.body}>
        <div className={styles.header}>
          <T>New Scratch File</T>
        </div>
        <SearchField
          ref={inputRef}
          variant="bare"
          data-autofocus
          value={filter}
          placeholder="Filter languages"
          aria-label="Filter languages"
          aria-controls={listId}
          aria-activedescendant={rows[current] ? `${listId}-${current}` : undefined}
          className={styles.search}
          onChange={(value) => {
            setFilter(value);
            setActive(0);
            inputRef.current?.focus();
          }}
          onKeyDown={onKeyDown}
        />
        <List
          id={listId}
          items={rows}
          getKey={(r) => (r ? `language:${r.lang.id}` : "recent-divider")}
          activeIndex={current}
          onActiveChange={setActive}
          onActivate={pick}
          isSection={isDivider}
          sectionHeight={8}
          renderSection={() => <span role="separator" className={styles.divider} />}
          focusable={false}
          hoverSelects
          className={styles.list}
          aria-label="Languages"
          empty={
            <div className={styles.empty}>
              <T>No matching languages</T>
            </div>
          }
          renderItem={(r, state) =>
            r && (
              <div className={clsx(styles.row, state.active && styles.active)} data-language={r.lang.id}>
                <Icon name={fileIconName(`scratch.${r.lang.ext}`)} size={16} className={styles.icon} />
                <span className={styles.label} title={r.lang.name}>
                  <HighlightedText text={r.lang.name} indices={r.matches ?? undefined} />
                </span>
              </div>
            )
          }
        />
      </div>
    </Popup>
  );
}
