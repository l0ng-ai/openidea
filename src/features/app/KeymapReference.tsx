import { useMemo, useState } from "react";
import { create } from "zustand";
import { useActions, type Action } from "@/platform/actions";
import { useT } from "@/platform/i18n";
import { effectiveBindings, formatBinding, useKeymap } from "@/platform/keymap";
import { Dialog, Kbd, SearchField } from "@/ui";
import styles from "./app.module.css";

export const useKeymapReference = create<{ open: boolean }>(() => ({ open: false }));
export const showKeymapReference = () => useKeymapReference.setState({ open: true });

export interface KeymapEntry {
  id: string;
  title: string;
  shortcuts: string[];
}

export interface KeymapGroup {
  category: string;
  entries: KeymapEntry[];
}

const CATEGORY_OF_PREFIX: Record<string, string> = {
  navigate: "Navigate",
  find: "Find",
  code: "Code",
  refactor: "Refactor",
  file: "File",
  editor: "Editor",
  project: "Project View",
  toolwindow: "Tool Windows",
  run: "Run",
  debug: "Debug",
  vcs: "Git",
};

function humanize(id: string): string {
  const last = id.slice(id.lastIndexOf(".") + 1);
  return last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

/**
 * Shortcuts grouped by category: every bound action, titled from the action
 * registry (keymap ids without a registered action use a humanised id).
 */
export function keymapReference(
  actions: Map<string, Action>,
  bindings: Array<[string, string]>,
  filter = "",
  other = "Other",
): KeymapGroup[] {
  const byId = new Map<string, string[]>();
  for (const [binding, id] of bindings) {
    const list = byId.get(id) ?? [];
    if (!list.includes(binding)) list.push(binding);
    byId.set(id, list);
  }
  const q = filter.trim().toLowerCase();
  const groups = new Map<string, KeymapEntry[]>();
  for (const [id, keys] of byId) {
    const action = actions.get(id);
    if (action?.hidden) continue;
    const title = action?.title ?? humanize(id);
    const shortcuts = keys.map((k) => formatBinding(k));
    if (q) {
      const hay = [title, id, ...shortcuts, ...keys].join(" ").toLowerCase();
      if (!hay.includes(q)) continue;
    }
    const category = action?.category ?? CATEGORY_OF_PREFIX[id.split(".")[0] ?? ""] ?? other;
    const list = groups.get(category) ?? [];
    list.push({ id, title, shortcuts });
    groups.set(category, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === other ? 1 : b === other ? -1 : a.localeCompare(b)))
    .map(([category, entries]) => ({ category, entries: entries.sort((a, b) => a.title.localeCompare(b.title)) }));
}

export function KeymapReferenceOverlay() {
  const open = useKeymapReference((s) => s.open);
  if (!open) return null;
  return <KeymapReferenceDialog onClose={() => useKeymapReference.setState({ open: false })} />;
}

function KeymapReferenceDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const actions = useActions((s) => s.actions);
  const keymap = useKeymap();
  const groups = useMemo(
    () => keymapReference(actions, effectiveBindings(), filter, t("app.keymap.other")),
    // `keymap` is read through effectiveBindings(); it is a dependency on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actions, keymap, filter, t],
  );
  const count = groups.reduce((n, g) => n + g.entries.length, 0);
  return (
    <Dialog open onClose={onClose} title={t("app.keymap.title")} width={720} position="top">
      <div className={styles.keymap}>
        <div className={styles.keymapBar}>
          <SearchField
            value={filter}
            onChange={setFilter}
            placeholder={t("app.keymap.filter")}
            aria-label={t("app.keymap.filter")}
            clearable
            data-autofocus=""
            className={styles.keymapSearch}
          />
          <span className={styles.keymapMeta}>
            {t("app.keymap.preset", { preset: keymap.preset })} · {t("app.keymap.count", { count })}
          </span>
        </div>
        <div className={styles.keymapBody}>
          {groups.length === 0 && <div className={styles.keymapEmpty}>{t("app.keymap.empty")}</div>}
          {groups.map((g) => (
            <section key={g.category} className={styles.keymapGroup} aria-label={g.category}>
              <h3 className={styles.keymapHeading}>{g.category}</h3>
              <ul className={styles.keymapList}>
                {g.entries.map((e) => (
                  <li key={e.id} className={styles.keymapRow} title={e.id}>
                    <span className={styles.keymapTitle}>{e.title}</span>
                    <span className={styles.keymapKeys}>
                      {e.shortcuts.map((s) => (
                        <Kbd key={`${e.id}:${s}`}>{s}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
