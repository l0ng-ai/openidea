/**
 * Keymap page (IDEA layout): keymap selector with a gear menu (Duplicate… /
 * Rename… / Restore Defaults / Delete), search by name or by recorded shortcut,
 * and the action tree grouped as Main Menu › File…Help, Editor Actions, Tool
 * Windows, Other, Plugins. Add / Remove / Reset via the context menu (Enter /
 * double-click adds). Edits are staged as the `keymap`, `keymapOverrides`
 * (bundled keymaps) and `customKeymaps` (user keymaps) settings, global scope.
 */
import { useMemo, useRef, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { useActions, allActions, type Action } from "@/platform/actions";
import { defaultPreset, formatBinding, type Keymap, PRESET_TITLES, PRESETS } from "@/platform/keymap";
import { confirm } from "@/workbench/messages";
import {
  HighlightedText,
  Icon,
  IconButton,
  Kbd,
  SearchField,
  Select,
  Tree,
  showContextMenu,
  wordMatch,
  type MenuItem,
  type SelectOption,
  T,
} from "@/ui";
import { useSetting } from "../components/context";
import { useSettingsDialog } from "../model/staging";
import { SearchLabel } from "../components/Form";
import {
  activeDraft,
  addBinding,
  bindingMatches,
  copyName,
  deleteKeymap,
  duplicateKeymap,
  isModified,
  keymapName,
  removeBinding,
  removeConflicts,
  renameKeymap,
  resetBindings,
  resolveBindings,
  switchPreset,
  withCustomOverrides,
  type CustomKeymaps,
  type KeymapDraft,
} from "./model";
import { groupIcon, groupPath, groupRank } from "./groups";
import { KeymapNameDialog } from "./KeymapDialogs";
import { RecordShortcutDialog } from "./RecordShortcutDialog";
import { StrokeRecorder } from "./StrokeRecorder";
import styles from "./Keymap.module.css";
import { tx } from "@/platform/i18n";

type KNode =
  | { kind: "group"; key: string; name: string; path: string[]; children: KNode[] }
  | { kind: "action"; key: string; action: Action; bindings: string[]; modified: boolean; hits: number[] | null };

type GroupNode = Extract<KNode, { kind: "group" }>;

export function keymapSearchLabels(): string[] {
  return allActions()
    .filter((a) => !a.hidden)
    .map((a) => a.title);
}

const groupKey = (path: readonly string[]) => `grp:${path.join("/")}`;

function sortGroup(g: GroupNode): void {
  const actions = g.children.filter((c) => c.kind === "action");
  const groups = g.children.filter((c): c is GroupNode => c.kind === "group");
  actions.sort((x, y) =>
    x.kind === "action" && y.kind === "action" ? x.action.title.localeCompare(y.action.title) : 0,
  );
  groups.sort((x, y) => groupRank(g.path, x.name) - groupRank(g.path, y.name) || x.name.localeCompare(y.name));
  groups.forEach(sortGroup);
  // Like a menu: the group's own actions, then its submenus.
  g.children = [...actions, ...groups];
}

/** Groups actions into IDEA's keymap tree, applying the name / shortcut filters. Empty groups are dropped. */
export function buildKeymapTree(
  actions: readonly Action[],
  draft: KeymapDraft,
  query: string,
  shortcut: string,
): KNode[] {
  const root: GroupNode = { kind: "group", key: "", name: "", path: [], children: [] };
  const groups = new Map<string, GroupNode>();
  const groupAt = (path: string[]): GroupNode => {
    let parent = root;
    for (let i = 1; i <= path.length; i++) {
      const sub = path.slice(0, i);
      const key = groupKey(sub);
      let g = groups.get(key);
      if (!g) {
        g = { kind: "group", key, name: sub[i - 1]!, path: sub, children: [] };
        groups.set(key, g);
        parent.children.push(g);
      }
      parent = g;
    }
    return parent;
  };
  const q = query.toLowerCase();
  for (const action of actions) {
    const bindings = resolveBindings(draft, action.id);
    if (action.hidden && !bindings.length) continue;
    let hits: number[] | null = null;
    if (query) {
      hits = wordMatch(action.title, query);
      if (!hits) {
        const other =
          action.id.toLowerCase().includes(q) || (action.keywords ?? []).some((k) => k.toLowerCase().includes(q));
        if (!other) continue;
        hits = [];
      }
    }
    if (shortcut && !bindingMatches(bindings, shortcut)) continue;
    groupAt(groupPath(action)).children.push({
      kind: "action",
      key: action.id,
      action,
      bindings,
      modified: isModified(draft, action.id),
      hits,
    });
  }
  sortGroup(root);
  return root.children;
}

/** Keys of every group node (for Expand All). */
function groupKeys(nodes: readonly KNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind !== "group") continue;
    out.push(n.key);
    groupKeys(n.children, out);
  }
  return out;
}

type NameDialog = { mode: "duplicate" | "rename"; initial: string } | null;

export function KeymapPage() {
  const [selected, setSelected] = useSetting<string>("keymap", "global");
  const [overrides, setOverrides] = useSetting<Keymap>("keymapOverrides", "global");
  const [customsRaw, setCustoms] = useSetting<CustomKeymaps | undefined>("customKeymaps", "global");
  const customs = useMemo(() => customsRaw ?? {}, [customsRaw]);
  const isCustom = !PRESETS[selected] && !!customs[selected];
  const selectedId = isCustom || PRESETS[selected] ? selected : defaultPreset();
  const draft = useMemo(() => activeDraft(selectedId, overrides ?? {}, customs), [selectedId, overrides, customs]);
  const actionMap = useActions((s) => s.actions);
  const actions = useMemo(() => [...actionMap.values()], [actionMap]);

  const [query, setQuery] = useState("");
  // A Settings search that landed here by action name filters the action tree too.
  const settingsQuery = useSettingsDialog((s) => s.query).trim();
  const [seenSettingsQuery, setSeenSettingsQuery] = useState<string | null>(null);
  if (seenSettingsQuery !== settingsQuery) {
    setSeenSettingsQuery(settingsQuery);
    const q = settingsQuery.toLowerCase();
    if (q && keymapSearchLabels().some((t) => t.toLowerCase().includes(q))) setQuery(settingsQuery);
    else if (!q) setQuery("");
  }
  const [byShortcut, setByShortcut] = useState(false);
  const [shortcut, setShortcut] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [lead, setLead] = useState<string | null>(null);
  const [recordFor, setRecordFor] = useState<Action | null>(null);
  const [recordMouse, setRecordMouse] = useState(false);
  const [nameDialog, setNameDialog] = useState<NameDialog>(null);
  const gearRef = useRef<HTMLButtonElement>(null);

  const roots = useMemo(
    () => buildKeymapTree(actions, draft, query.trim(), byShortcut ? shortcut : ""),
    [actions, draft, query, byShortcut, shortcut],
  );
  const allGroups = useMemo(() => groupKeys(roots), [roots]);
  const filtering = !!query.trim() || (byShortcut && !!shortcut);
  const expanded = useMemo(
    () => new Set(allGroups.filter((k) => filtering || !collapsed.has(k))),
    [allGroups, collapsed, filtering],
  );

  const overrideCount = Object.keys(draft.overrides).length;

  const change = (next: Keymap) => {
    if (isCustom) setCustoms(withCustomOverrides(customs, selectedId, next));
    else setOverrides(next);
  };

  const selectKeymap = (id: string) => {
    if (id === selectedId) return;
    if (PRESETS[id] && !isCustom) {
      // Bundled → bundled: carry the modifications over (re-based on the new preset).
      const next = switchPreset(draft, id);
      setSelected(next.preset);
      setOverrides(next.overrides);
    } else {
      setSelected(id);
    }
  };

  const keymapOptions: SelectOption[] = [
    ...Object.keys(PRESETS).map((id) => ({ value: id, label: PRESET_TITLES[id] ?? id })),
    ...Object.entries(customs)
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([id, k]) => ({ value: id, label: k.name, detail: tx`based on ${PRESET_TITLES[k.parent] ?? k.parent}` })),
  ];

  const confirmDelete = async () => {
    if (
      !(await confirm({
        title: "Delete Keymap",
        message: tx`Delete keymap '${keymapName(selectedId, customs)}'?`,
        ok: "Delete",
      }))
    )
      return;
    const next = deleteKeymap(customs, selectedId);
    setCustoms(next.customs);
    setSelected(next.selected);
  };

  const gearMenu = (): MenuItem[] => [
    {
      label: "Duplicate…",
      icon: "copy",
      run: () => setNameDialog({ mode: "duplicate", initial: copyName(keymapName(selectedId, customs), customs) }),
    },
    {
      label: "Rename…",
      icon: "edit",
      disabled: !isCustom,
      run: () => setNameDialog({ mode: "rename", initial: keymapName(selectedId, customs) }),
    },
    { label: "Restore Defaults", icon: "undo", disabled: !overrideCount, run: () => change({}) },
    // Bundled keymaps cannot be deleted (IDEA hides the item for them).
    ...(isCustom
      ? ([
          { kind: "separator" },
          { label: "Delete", icon: "trash", danger: true, run: () => void confirmDelete() },
        ] satisfies MenuItem[])
      : []),
  ];

  const menuFor = (action: Action): MenuItem[] => {
    const bindings = resolveBindings(draft, action.id);
    return [
      {
        label: "Add Keyboard Shortcut",
        icon: "keyboard",
        run: () => {
          setRecordMouse(false);
          setRecordFor(action);
        },
      },
      {
        label: "Add Mouse Shortcut",
        run: () => {
          setRecordMouse(true);
          setRecordFor(action);
        },
      },
      { kind: "separator" },
      ...(bindings.length
        ? bindings.map((b) => ({
            label: tx`Remove ${formatBinding(b)}`,
            icon: "minus",
            run: () => change(removeBinding(draft, action.id, b)),
          }))
        : [{ label: "Remove", disabled: true }]),
      { kind: "separator" },
      {
        label: "Reset Shortcuts",
        icon: "undo",
        disabled: !isModified(draft, action.id),
        run: () => change(resetBindings(draft, action.id)),
      },
    ];
  };

  const leadAction = lead ? actionMap.get(lead) : undefined;

  return (
    <div className={styles.page}>
      <div className={styles.presetRow}>
        <span className={styles.presetLabel}>
          <SearchLabel text="Keymap:" />
        </span>
        <Select
          value={selectedId}
          aria-label="Keymap"
          className={styles.presetSelect}
          options={keymapOptions}
          onChange={selectKeymap}
        />
        <IconButton
          ref={gearRef}
          icon="settings"
          title="Show Scheme Actions"
          onClick={() => {
            const r = gearRef.current?.getBoundingClientRect();
            showContextMenu(r ? { x: r.left, y: r.bottom + 2 } : { x: 0, y: 0 }, gearMenu());
          }}
        />
        <span className={styles.spacer} />
        {overrideCount > 0 && (
          <span className={styles.modifiedNote}>
            {overrideCount === 1 ? tx`${overrideCount} modified action` : tx`${overrideCount} modified actions`}
          </span>
        )}
      </div>

      <div className={styles.toolbar}>
        {byShortcut ? (
          <div className={styles.shortcutFilter}>
            <Icon name="keyboard" size={14} className={styles.leading} />
            <StrokeRecorder
              autoFocus
              chord
              value={shortcut}
              onChange={setShortcut}
              placeholder="Press a shortcut to find actions"
              aria-label="Find actions by shortcut"
              className={styles.filterRecorder}
            />
            {shortcut && (
              <IconButton icon="close" title="Clear" size="small" iconSize={12} onClick={() => setShortcut("")} />
            )}
          </div>
        ) : (
          <SearchField
            className={styles.search}
            value={query}
            onChange={setQuery}
            placeholder="Search actions"
            aria-label="Search actions"
          />
        )}
        <IconButton
          icon="keyboard"
          title="Find Actions by Shortcut"
          pressed={byShortcut}
          onClick={() => {
            setByShortcut((v) => !v);
            setShortcut("");
          }}
        />
        <IconButton
          icon="filter"
          title="Clear Filtering"
          disabled={!filtering}
          onClick={() => {
            setQuery("");
            setShortcut("");
          }}
        />
        <span className={styles.toolbarSep} aria-hidden />
        <IconButton icon="expand-all" title="Expand All" onClick={() => setCollapsed(new Set())} />
        <IconButton icon="collapse-all" title="Collapse All" onClick={() => setCollapsed(new Set(allGroups))} />
        <span className={styles.spacer} />
        <IconButton
          icon="plus"
          title="Add Keyboard Shortcut"
          disabled={!leadAction}
          onClick={() => {
            if (!leadAction) return;
            setRecordMouse(false);
            setRecordFor(leadAction);
          }}
        />
      </div>

      <div className={styles.treeWrap}>
        <Tree<KNode>
          aria-label="Actions"
          roots={roots}
          getKey={(n) => n.key}
          getLabel={(n) => (n.kind === "group" ? n.name : n.action.title)}
          getChildren={(n) => (n.kind === "group" ? n.children : undefined)}
          isExpandable={(n) => n.kind === "group"}
          expanded={expanded}
          onExpandedChange={(_set, node, isExpanded) => {
            if (filtering) return;
            setCollapsed((c) => {
              const next = new Set(c);
              if (isExpanded) next.delete(node.key);
              else next.add(node.key);
              return next;
            });
          }}
          multiSelect={false}
          speedSearch={false}
          onSelectionChange={(_sel, node) => setLead(node?.kind === "action" ? node.key : null)}
          onActivate={(n) => n.kind === "action" && setRecordFor(n.action)}
          onContextMenu={(n, _sel, e: MouseEvent) => {
            if (n?.kind !== "action") return;
            e.preventDefault();
            showContextMenu(e, menuFor(n.action));
          }}
          empty={
            <div className={styles.empty}>
              <T>Nothing to show</T>
            </div>
          }
          renderNode={(n, state) =>
            n.kind === "group" ? (
              <span className={styles.catRow}>
                <Icon name={groupIcon(n.path, state.expanded)} size={14} className={styles.catIcon} />
                <span className={styles.catName}>{n.name}</span>
              </span>
            ) : (
              <span className={styles.actionRow}>
                <span className={styles.actionIcon}>{n.action.icon && <Icon name={n.action.icon} size={14} />}</span>
                <HighlightedText
                  className={clsx(styles.actionTitle, n.modified && styles.modified)}
                  text={n.action.title}
                  indices={n.hits}
                  tone={state.selected ? "accent" : "strong"}
                />
                <span className={styles.bindings}>
                  {n.bindings.map((b) => (
                    <Kbd key={b} binding={b} className={styles.kbd} />
                  ))}
                </span>
              </span>
            )
          }
        />
      </div>

      {recordFor && (
        <RecordShortcutDialog
          action={recordFor}
          mouse={recordMouse}
          actions={actions}
          draft={draft}
          onCancel={() => setRecordFor(null)}
          onSubmit={(binding, conflicts, remove) => {
            const base = remove ? { ...draft, overrides: removeConflicts(draft, conflicts) } : draft;
            change(addBinding(base, recordFor.id, binding));
            setRecordFor(null);
          }}
        />
      )}

      {nameDialog && (
        <KeymapNameDialog
          title={nameDialog.mode === "duplicate" ? "Duplicate Keymap" : "Rename Keymap"}
          initial={nameDialog.initial}
          customs={customs}
          ownId={nameDialog.mode === "rename" ? selectedId : undefined}
          onCancel={() => setNameDialog(null)}
          onSubmit={(name) => {
            if (nameDialog.mode === "duplicate") {
              const dup = duplicateKeymap(draft, customs, name);
              setCustoms(dup.customs);
              setSelected(dup.id);
            } else {
              setCustoms(renameKeymap(customs, selectedId, name));
            }
            setNameDialog(null);
          }}
        />
      )}
    </div>
  );
}
