/**
 * Editor › File Types › Recognized File Types: languages from
 * `languages/*.toml` with their file name patterns (the definition's plus the
 * user's) and hashbang patterns, stored in `files.fileTypes`. The backend
 * detects languages with them; open editors re-detect when they change.
 */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Icon, Input, T, fileIconName } from "@/ui";
import { commands, isTauri, type LanguageInfo_Serialize as LanguageInfo } from "@/platform/ipc";
import {
  addPattern,
  effectivePatterns,
  removePattern,
  sampleFileName,
  setHashbangs,
  type FileTypeAssociations,
} from "@/platform/fileTypes";
import { GlobListEditor, Row } from "../components/Form";
import { useSetting } from "../components/context";
import styles from "./FileTypes.module.css";
import { tx } from "@/platform/i18n";

function useLanguages(): LanguageInfo[] {
  const [langs, setLangs] = useState<LanguageInfo[]>([]);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    void commands
      .languages()
      .then((list) => live && setLangs([...list].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return langs;
}

/** Applies an edited pattern list as additions / removals (a pattern moves between languages). */
export function applyPatternEdit(
  assoc: FileTypeAssociations,
  langs: readonly LanguageInfo[],
  lang: LanguageInfo,
  next: readonly string[],
): FileTypeAssociations {
  const before = effectivePatterns(lang, assoc).map((p) => p.pattern);
  let out = assoc;
  for (const p of before) if (!next.includes(p)) out = removePattern(out, lang, p);
  for (const p of next) if (!before.includes(p)) out = addPattern(out, langs, lang.id, p);
  return out;
}

export function RecognizedFileTypes() {
  const langs = useLanguages();
  const [assoc, setAssoc] = useSetting<FileTypeAssociations>("files.fileTypes");
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? langs.filter(
          (l) =>
            l.name.toLowerCase().includes(q) ||
            effectivePatterns(l, assoc ?? {}).some((p) => p.pattern.toLowerCase().includes(q)),
        )
      : langs;
  }, [langs, filter, assoc]);
  const selected = langs.find((l) => l.id === selectedId) ?? shown[0] ?? null;
  if (!isTauri()) return null;
  const current = assoc ?? {};
  const patterns = selected ? effectivePatterns(selected, current).map((p) => p.pattern) : [];
  const hashbangs = selected ? (current[selected.id]?.hashbangs ?? []) : [];

  return (
    <div className={styles.fileTypes}>
      <div className={styles.types}>
        <Input
          className={styles.filter}
          value={filter}
          placeholder="Filter file types"
          aria-label="Filter file types"
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className={styles.typeList} role="listbox" aria-label={tx("Recognized file types")}>
          {shown.map((l) => {
            const sample = sampleFileName(l);
            return (
              <button
                key={l.id}
                type="button"
                role="option"
                aria-selected={l.id === selected?.id}
                className={clsx(styles.type, l.id === selected?.id && styles.typeSelected)}
                onClick={() => setSelectedId(l.id)}
              >
                <Icon name={sample ? fileIconName(sample) : "file-text"} size={16} />
                <span className={styles.typeName}>{l.name}</span>
                {current[l.id] && (
                  <span className={styles.modified}>
                    <T>modified</T>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {selected && (
        <div className={styles.patterns}>
          <Row label="File name patterns" stacked hint="* matches any characters, ? one (e.g. *.foo, Jenkinsfile).">
            <GlobListEditor
              value={patterns}
              onChange={(next) => setAssoc(applyPatternEdit(current, langs, selected, next))}
              placeholder="*.ext"
              aria-label={tx`File name patterns of ${selected.name}`}
            />
          </Row>
          <Row
            label="Hashbang patterns"
            stacked
            hint="Interpreters run by a #! first line, e.g. node for #!/usr/bin/env node."
          >
            <GlobListEditor
              value={hashbangs}
              onChange={(next) => setAssoc(setHashbangs(current, selected.id, next))}
              placeholder="interpreter"
              aria-label={tx`Hashbang patterns of ${selected.name}`}
            />
          </Row>
          {selected.firstLine && (
            <div className={styles.note}>
              <T>Also recognized by its first line:</T> <code className={styles.code}>{selected.firstLine}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Files opened in associated applications: names handed to the OS instead of an editor. */
export function AssociatedApplicationsRow() {
  const [patterns, setPatterns] = useSetting<string[]>("files.associatedApplications");
  return (
    <Row
      label="File name patterns"
      stacked
      hint="Files matching these patterns open in their system application instead of an editor."
    >
      <GlobListEditor
        value={patterns ?? []}
        onChange={setPatterns}
        placeholder="*.xlsx"
        aria-label="Files opened in associated applications"
      />
    </Row>
  );
}
