/** Customize Main Toolbar dialog: the entries of each side, reorderable, plus added actions. */
import { useMemo, useState } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { allActions } from "@/platform/actions";
import { t } from "@/platform/i18n";
import { Button, Dialog, Icon, List, SearchField, T, fuzzyMatch } from "@/ui";
import { useContributions } from "./contributions";
import {
  ACTION_PREFIX,
  editableToolbar,
  isActionEntry,
  saveToolbar,
  defaultToolbar,
  entryAction,
  useMainToolbarSettings,
  widgetTitle,
  type ToolbarLayout,
} from "./mainToolbar";
import styles from "./MainToolbarDialog.module.css";

const useCustomize = create<{ open: boolean }>(() => ({ open: false }));
export const showCustomizeToolbar = () => useCustomize.setState({ open: true });

export function MainToolbarDialogHost() {
  const open = useCustomize((s) => s.open);
  return open ? <CustomizeDialog onClose={() => useCustomize.setState({ open: false })} /> : null;
}

type Side = "left" | "right";
const SIDES: Side[] = ["left", "right"];

function move(layout: ToolbarLayout, side: Side, index: number, delta: -1 | 1): ToolbarLayout {
  const list = [...layout[side]];
  const j = index + delta;
  if (j < 0 || j >= list.length) return layout;
  [list[index], list[j]] = [list[j]!, list[index]!];
  return { ...layout, [side]: list };
}

function remove(layout: ToolbarLayout, side: Side, index: number): ToolbarLayout {
  const id = layout[side][index];
  if (id === undefined) return layout;
  return {
    ...layout,
    [side]: layout[side].filter((_, i) => i !== index),
    hidden: isActionEntry(id) || layout.hidden.includes(id) ? layout.hidden : [...layout.hidden, id],
  };
}

function CustomizeDialog({ onClose }: { onClose: () => void }) {
  const items = useContributions((s) => s.titleItems);
  const saved = useMainToolbarSettings();
  const [layout, setLayout] = useState<ToolbarLayout>(() => editableToolbar(saved, items.values()));
  const [sel, setSel] = useState<{ side: Side; index: number }>({ side: "left", index: 0 });
  const [adding, setAdding] = useState(false);
  const selected = layout[sel.side][sel.index];

  const apply = async () => {
    await saveToolbar(layout);
    onClose();
  };
  const add = (id: string) => {
    const side = sel.side;
    const at = selected === undefined ? layout[side].length : sel.index + 1;
    const list = [...layout[side].filter((x) => x !== id)];
    list.splice(Math.min(at, list.length), 0, id);
    setLayout({ ...layout, [side]: list, hidden: layout.hidden.filter((x) => x !== id) });
    setSel({ side, index: list.indexOf(id) });
    setAdding(false);
  };

  return (
    <Dialog
      open
      title="Customize Main Toolbar"
      onClose={onClose}
      width={620}
      footerStart={
        <Button
          onClick={() => {
            setLayout(defaultToolbar(items.values()));
            setSel({ side: "left", index: 0 });
          }}
        >
          <T>Restore Defaults</T>
        </Button>
      }
      buttons={[
        { label: "OK", role: "default", onClick: () => void apply() },
        { label: t("common.cancel"), role: "cancel" },
      ]}
    >
      <div className={styles.body}>
        <div className={styles.sides}>
          {SIDES.map((side) => (
            <section key={side} className={styles.side} aria-label={side === "left" ? "Left" : "Right"}>
              <h3 className={styles.heading}>{side === "left" ? <T>Left</T> : <T>Right</T>}</h3>
              <List
                items={layout[side]}
                getKey={(id) => id}
                activeIndex={sel.side === side ? sel.index : -1}
                onActiveChange={(index) => setSel({ side, index })}
                className={styles.list}
                aria-label={side === "left" ? "Left group" : "Right group"}
                empty={
                  <div className={styles.empty}>
                    <T>Empty</T>
                  </div>
                }
                renderItem={(id) => (
                  <div className={styles.row}>
                    <Icon
                      name={isActionEntry(id) ? (allActionIcon(id) ?? "run") : "main-menu"}
                      size={14}
                      className={styles.rowIcon}
                    />
                    <span className={styles.rowLabel}>{widgetTitle(id, items)}</span>
                  </div>
                )}
              />
            </section>
          ))}
        </div>
        <div className={styles.buttons}>
          <Button onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
            <T>Add…</T>
          </Button>
          <Button
            disabled={selected === undefined}
            onClick={() => {
              setLayout(remove(layout, sel.side, sel.index));
              setSel({ ...sel, index: Math.max(0, sel.index - 1) });
            }}
          >
            <T>Remove</T>
          </Button>
          <Button
            disabled={sel.index <= 0 || selected === undefined}
            onClick={() => {
              setLayout(move(layout, sel.side, sel.index, -1));
              setSel({ ...sel, index: sel.index - 1 });
            }}
          >
            <T>Move Up</T>
          </Button>
          <Button
            disabled={selected === undefined || sel.index >= layout[sel.side].length - 1}
            onClick={() => {
              setLayout(move(layout, sel.side, sel.index, 1));
              setSel({ ...sel, index: sel.index + 1 });
            }}
          >
            <T>Move Down</T>
          </Button>
          <Button
            disabled={selected === undefined}
            onClick={() => {
              if (selected === undefined) return;
              const other: Side = sel.side === "left" ? "right" : "left";
              setLayout({
                ...layout,
                [sel.side]: layout[sel.side].filter((_, i) => i !== sel.index),
                [other]: [...layout[other], selected],
              });
              setSel({ side: other, index: layout[other].length });
            }}
          >
            {sel.side === "left" ? <T>Move to Right</T> : <T>Move to Left</T>}
          </Button>
        </div>
        {adding && <AddPicker hidden={layout.hidden} present={[...layout.left, ...layout.right]} onPick={add} />}
      </div>
    </Dialog>
  );
}

function allActionIcon(id: string): string | undefined {
  return allActions().find((a) => a.id === entryAction(id))?.icon;
}

/** Removed widgets, then every visible action with an icon, filtered by the query. */
function AddPicker({ hidden, present, onPick }: { hidden: string[]; present: string[]; onPick: (id: string) => void }) {
  const items = useContributions((s) => s.titleItems);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const candidates = useMemo(() => {
    const widgets = hidden.map((id) => ({ id, label: widgetTitle(id, items), detail: "Widget", icon: "main-menu" }));
    const actions = allActions()
      .filter((a) => !a.hidden && a.icon && !present.includes(`${ACTION_PREFIX}${a.id}`))
      .map((a) => ({ id: `${ACTION_PREFIX}${a.id}`, label: a.title, detail: a.category ?? "", icon: a.icon! }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const all = [...widgets, ...actions];
    return query.trim() ? all.filter((c) => fuzzyMatch(c.label, query.trim())) : all;
  }, [hidden, present, items, query]);
  return (
    <div className={styles.picker}>
      <SearchField
        value={query}
        onChange={(v) => {
          setQuery(v);
          setActive(0);
        }}
        placeholder="Search actions"
        aria-label="Search actions"
        autoFocus
      />
      <List
        items={candidates}
        getKey={(c) => c.id}
        activeIndex={active}
        onActiveChange={setActive}
        onActivate={(c) => onPick(c.id)}
        className={styles.pickerList}
        aria-label="Actions and widgets to add"
        renderItem={(c, state) => (
          <div className={clsx(styles.row, state.active && styles.activeRow)}>
            <Icon name={c.icon} size={14} className={styles.rowIcon} />
            <span className={styles.rowLabel}>{c.label}</span>
            <span className={styles.rowDetail}>{c.detail}</span>
          </div>
        )}
      />
    </div>
  );
}
