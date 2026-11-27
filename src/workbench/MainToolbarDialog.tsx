/** Customize Main Toolbar dialog: the entries of each side, reorderable, plus added actions. */
import { useMemo, useState } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { allActions } from "@/platform/actions";
import { t, tx } from "@/platform/i18n";
import { Dialog, Icon, IconButton, List, SearchField, T, fuzzyMatch } from "@/ui";
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
  TOOLBAR_SIDES,
  type ToolbarLayout,
  type ToolbarSide,
} from "./mainToolbar";
import styles from "./MainToolbarDialog.module.css";

const useCustomize = create<{ open: boolean }>(() => ({ open: false }));
export const showCustomizeToolbar = () => useCustomize.setState({ open: true });

export function MainToolbarDialogHost() {
  const open = useCustomize((s) => s.open);
  return open ? <CustomizeDialog onClose={() => useCustomize.setState({ open: false })} /> : null;
}

type Side = ToolbarSide;

const SIDE_TITLES: Record<Side, string> = { left: "Left", center: "Center", right: "Right" };
const GROUP_LABELS: Record<Side, string> = { left: "Left group", center: "Center group", right: "Right group" };
const MOVE_TITLES: Record<Side, string> = { left: "Move to Left", center: "Move to Center", right: "Move to Right" };

/** Moves entry `index` of `side` to the end of the group `to`. */
export function moveToGroup(layout: ToolbarLayout, side: Side, index: number, to: Side): ToolbarLayout {
  const id = layout[side][index];
  if (id === undefined || to === side) return layout;
  return { ...layout, [side]: layout[side].filter((_, i) => i !== index), [to]: [...layout[to], id] };
}

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
      width={760}
      buttons={[
        { label: "OK", role: "default", onClick: () => void apply() },
        { label: t("common.cancel"), role: "cancel" },
      ]}
    >
      <div className={styles.body}>
        <div className={styles.toolbar} role="toolbar" aria-label={tx("Toolbar actions")}>
          <IconButton
            icon="plus"
            title="Add…"
            size="small"
            onClick={() => setAdding((v) => !v)}
            aria-expanded={adding}
          />
          <IconButton
            icon="minus"
            title="Remove"
            size="small"
            disabled={selected === undefined}
            onClick={() => {
              setLayout(remove(layout, sel.side, sel.index));
              setSel({ ...sel, index: Math.max(0, sel.index - 1) });
            }}
          />
          <IconButton
            icon="arrow-up"
            title="Move Up"
            size="small"
            disabled={sel.index <= 0 || selected === undefined}
            onClick={() => {
              setLayout(move(layout, sel.side, sel.index, -1));
              setSel({ ...sel, index: sel.index - 1 });
            }}
          />
          <IconButton
            icon="arrow-down"
            title="Move Down"
            size="small"
            disabled={selected === undefined || sel.index >= layout[sel.side].length - 1}
            onClick={() => {
              setLayout(move(layout, sel.side, sel.index, 1));
              setSel({ ...sel, index: sel.index + 1 });
            }}
          />
          {([-1, 1] as const).map((step) => {
            const to = TOOLBAR_SIDES[TOOLBAR_SIDES.indexOf(sel.side) + step];
            return (
              <IconButton
                key={step}
                icon={step < 0 ? "arrow-left" : "arrow-right"}
                title={MOVE_TITLES[to ?? (step < 0 ? "left" : "right")]}
                size="small"
                disabled={selected === undefined || !to}
                onClick={() => {
                  if (!to) return;
                  setLayout(moveToGroup(layout, sel.side, sel.index, to));
                  setSel({ side: to, index: layout[to].length });
                }}
              />
            );
          })}
          <IconButton
            icon="undo"
            title="Restore Defaults"
            size="small"
            onClick={() => {
              setLayout(defaultToolbar(items.values()));
              setSel({ side: "left", index: 0 });
            }}
          />
        </div>
        {adding && (
          <AddPicker hidden={layout.hidden} present={TOOLBAR_SIDES.flatMap((side) => layout[side])} onPick={add} />
        )}
        <div className={styles.sides}>
          {TOOLBAR_SIDES.map((side) => (
            <section key={side} className={styles.side} aria-label={SIDE_TITLES[side]}>
              <h3 className={styles.heading}>
                <T>{SIDE_TITLES[side]}</T>
              </h3>
              <List
                items={layout[side]}
                getKey={(id) => id}
                activeIndex={sel.side === side ? sel.index : -1}
                onActiveChange={(index) => setSel({ side, index })}
                autoFocus={side === "left"}
                className={styles.list}
                aria-label={GROUP_LABELS[side]}
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
