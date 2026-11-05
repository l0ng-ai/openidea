/**
 * The funnel popup of a Search Everywhere tab: checklists of file types /
 * languages / symbol kinds (with "All") or the Text tab's file mask.
 * Changes apply immediately and are remembered per tab.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Input, Popup, T, type PopupAnchor } from "@/ui";
import { recentMasks, refreshProjectMasks, useProjectMasks } from "../find/store";
import { KIND_LABELS, kindsFor, type FilterTab, type SeFilters } from "./filters";
import { loadLanguages } from "./deps";
import { setSearchEverywhereFilter } from "./store";
import styles from "./SearchEverywhere.module.css";

interface Option {
  id: string;
  label: string;
  /** A UI string (kinds), translated; language names are shown as is. */
  translate?: boolean;
}

function Checklist({
  title,
  options,
  excluded,
  onChange,
}: {
  title: string;
  options: readonly Option[];
  excluded: readonly string[];
  onChange: (excluded: string[]) => void;
}) {
  const off = new Set(excluded);
  const shown = options.filter((o) => !off.has(o.id)).length;
  return (
    <div className={styles.filterGroup} role="group" aria-label={title}>
      <div className={styles.filterTitle}>
        <T>{title}</T>
      </div>
      <Checkbox
        className={styles.filterAll}
        checked={shown === options.length}
        indeterminate={shown > 0 && shown < options.length}
        label="All"
        onChange={(v) => onChange(v ? [] : options.map((o) => o.id))}
      />
      <div className={styles.filterItems}>
        {options.map((o) => (
          <Checkbox
            key={o.id}
            checked={!off.has(o.id)}
            label={o.translate ? o.label : <span>{o.label}</span>}
            aria-label={o.label}
            onChange={(v) => onChange(v ? excluded.filter((x) => x !== o.id) : [...excluded, o.id])}
          />
        ))}
      </div>
    </div>
  );
}

export function FilterPopup({
  tab,
  filters,
  anchor,
  onClose,
}: {
  tab: FilterTab;
  filters: SeFilters;
  anchor: PopupAnchor;
  onClose: () => void;
}) {
  const [languages, setLanguages] = useState<Option[]>([]);
  useEffect(() => {
    if (tab === "text") return;
    let alive = true;
    void loadLanguages().then((list) => {
      if (!alive) return;
      setLanguages(
        list
          .filter((l) => l.extensions.length > 0)
          .map((l) => ({ id: l.id, label: l.name }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      );
    });
    return () => {
      alive = false;
    };
  }, [tab]);
  const kinds = useMemo<Option[]>(
    () =>
      tab === "classes" || tab === "symbols"
        ? kindsFor(tab).map((k) => ({ id: k, label: KIND_LABELS[k] ?? k, translate: true }))
        : [],
    [tab],
  );

  return (
    <Popup
      open
      anchor={anchor}
      placement="bottom-end"
      onClose={onClose}
      className={styles.filterPopup}
      aria-label="Filter"
      trapFocus
    >
      {tab === "text" ? (
        <MaskFilter mask={filters.text.mask} onClose={onClose} />
      ) : tab === "files" ? (
        <Checklist
          title="File Types"
          options={languages}
          excluded={filters.files.languages}
          onChange={(languages) => setSearchEverywhereFilter("files", { languages })}
        />
      ) : (
        <>
          <Checklist
            title={tab === "classes" ? "Kinds" : "Symbol Kinds"}
            options={kinds}
            excluded={filters[tab].kinds}
            onChange={(k) => setSearchEverywhereFilter(tab, { ...filters[tab], kinds: k })}
          />
          <Checklist
            title="Languages"
            options={languages}
            excluded={filters[tab].languages}
            onChange={(l) => setSearchEverywhereFilter(tab, { ...filters[tab], languages: l })}
          />
        </>
      )}
    </Popup>
  );
}

function MaskFilter({ mask, onClose }: { mask: string; onClose: () => void }) {
  const [value, setValue] = useState(mask);
  const projectMasks = useProjectMasks((p) => p.masks);
  useEffect(() => void refreshProjectMasks(), []);
  const apply = (m: string) => setSearchEverywhereFilter("text", { mask: m.trim() });
  return (
    <div className={styles.filterGroup}>
      <label className={styles.filterTitle} htmlFor="se-file-mask">
        <T>File mask</T>
      </label>
      <Input
        id="se-file-mask"
        data-autofocus
        value={value}
        placeholder={projectMasks[0] ?? ""}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          apply(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <div className={styles.filterMasks}>
        {recentMasks()
          .slice(0, 8)
          .map((m) => (
            <button
              key={m}
              type="button"
              className={styles.filterMask}
              onClick={() => {
                setValue(m);
                apply(m);
              }}
            >
              {m}
            </button>
          ))}
      </div>
      {mask && (
        <Button
          variant="ghost"
          size="small"
          onClick={() => {
            setValue("");
            apply("");
          }}
        >
          Clear
        </Button>
      )}
    </div>
  );
}
