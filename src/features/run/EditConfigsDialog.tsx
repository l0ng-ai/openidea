import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri, type RunConfig } from "@/platform/ipc";
import { letterOf } from "@/platform/keymap";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { Button, Dialog, Icon, IconButton, Input, T } from "@/ui";
import {
  notifications,
  useRunConfigTypes,
  runConfigTypes,
  type RunConfigTypeContribution,
} from "@/workbench/contributions";
import { AddConfigPopup } from "./AddConfigPopup";
import { ConfigForm, Field } from "./ConfigForm";
import {
  commandLine,
  configIcon,
  duplicateConfig,
  groupConfigs,
  hasErrors,
  kindLabel,
  removeConfig,
  upsertConfig,
  userConfigs,
  validateConfig,
  type ConfigErrors,
} from "./configs";
import { targetName } from "./remote";
import { saveUserConfigs, selectConfig, useRun } from "./store";
import { blankTemplate, COMPOUND, missingParams, newConfigOfType, templateId, typeFor } from "./types";
import styles from "./Run.module.css";
import { tx } from "@/platform/i18n";

export function EditConfigsOverlay() {
  const open = useRun((s) => s.editorOpen);
  if (!open) return null;
  return <EditConfigsDialog />;
}

type Selection =
  | { type: "config"; id: string }
  | { type: "folder"; kind: string; name: string }
  | { type: "template"; kind: string };

export type TreeRow =
  | { type: "group"; key: string; kind: string; label: string; icon: string }
  | { type: "folder"; key: string; kind: string; name: string }
  | { type: "config"; key: string; config: RunConfig; depth: 1 | 2 };

/** Sidebar rows: type groups, their folders (first), then loose configurations; collapsed nodes hide their children. */
export function treeRows(
  configs: readonly RunConfig[],
  extraFolders: ReadonlyArray<{ kind: string; name: string }> = [],
  collapsed: ReadonlySet<string> = new Set(),
): TreeRow[] {
  const rows: TreeRow[] = [];
  const groups = groupConfigs(configs);
  for (const f of extraFolders)
    if (!groups.some((g) => g.kind === f.kind)) groups.push({ kind: f.kind, label: kindLabel(f.kind), configs: [] });
  for (const g of groups) {
    const groupKey = `g:${g.kind}`;
    rows.push({
      type: "group",
      key: groupKey,
      kind: g.kind,
      label: g.label,
      icon: configIcon({ kind: g.kind, isTest: false }),
    });
    if (collapsed.has(groupKey)) continue;
    const folders: string[] = [];
    for (const c of g.configs) if (c.folder && !folders.includes(c.folder)) folders.push(c.folder);
    for (const f of extraFolders) if (f.kind === g.kind && !folders.includes(f.name)) folders.push(f.name);
    for (const name of folders) {
      const folderKey = `f:${g.kind}:${name}`;
      rows.push({ type: "folder", key: folderKey, kind: g.kind, name });
      if (collapsed.has(folderKey)) continue;
      for (const c of g.configs)
        if (c.folder === name) rows.push({ type: "config", key: `c:${c.id}`, config: c, depth: 2 });
    }
    for (const c of g.configs) if (!c.folder) rows.push({ type: "config", key: `c:${c.id}`, config: c, depth: 1 });
  }
  return rows;
}

/** Moves `id` before / after its neighbour among the configurations of the same type and folder. */
export function moveConfig(configs: readonly RunConfig[], id: string, delta: -1 | 1): RunConfig[] {
  const current = configs.find((c) => c.id === id);
  if (!current) return [...configs];
  const siblings = configs.filter((c) => c.kind === current.kind && (c.folder ?? "") === (current.folder ?? ""));
  const at = siblings.indexOf(current);
  const other = siblings[at + delta];
  if (!other) return [...configs];
  const out = [...configs];
  const i = out.indexOf(current);
  const j = out.indexOf(other);
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

function uniqueFolder(
  kind: string,
  configs: readonly RunConfig[],
  extra: ReadonlyArray<{ kind: string; name: string }>,
): string {
  const taken = new Set([
    ...configs.filter((c) => c.kind === kind).map((c) => c.folder),
    ...extra.filter((f) => f.kind === kind).map((f) => f.name),
  ]);
  if (!taken.has("New Folder")) return "New Folder";
  for (let i = 2; ; i++) if (!taken.has(`New Folder (${i})`)) return `New Folder (${i})`;
}

const isMac = () => typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

function EditConfigsDialog() {
  const initialConfigs = useRun((s) => s.configs);
  const temporary = useRun((s) => s.temporary);
  const target = useRun((s) => s.editTarget ?? s.selectedId);
  const types = useRunConfigTypes((s) => s.types);
  const [draft, setDraft] = useState<RunConfig[]>(() => initialConfigs.map((c) => structuredClone(c)));
  const [selection, setSelection] = useState<Selection | null>(() => {
    const id = initialConfigs.some((c) => c.id === target) ? target : initialConfigs[0]?.id;
    return id ? { type: "config", id } : null;
  });
  const [mode, setMode] = useState<"configs" | "templates">("configs");
  const [templates, setTemplates] = useState<RunConfig[] | null>(() => (isTauri() ? null : []));
  const [templatesDirty, setTemplatesDirty] = useState(false);
  const [extraFolders, setExtraFolders] = useState<Array<{ kind: string; name: string }>>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  // "Modify Run Configuration…": the would-be configuration is saved on OK even when unedited.
  const [dirty, setDirty] = useState(() => useRun.getState().editDirty);
  const [saving, setSaving] = useState(false);
  const runTargets = useWorkflowSettings((s) => s.runTargets);
  const [adding, setAdding] = useState<{ x: number; y: number } | null>(null);
  const [modifyRequest, setModifyRequest] = useState(0);
  const addRef = useRef<HTMLButtonElement>(null);
  const dragged = useRef<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    call(commands.runTemplates())
      .then((t) => live && setTemplates(t))
      .catch(() => live && setTemplates([]));
    return () => {
      live = false;
    };
  }, []);

  const close = () => useRun.setState({ editorOpen: false, editTarget: null });
  const current = selection?.type === "config" ? (draft.find((c) => c.id === selection.id) ?? null) : null;
  const templateFor = (kind: string): RunConfig | null => {
    const t = typeFor(kind);
    return templates?.find((x) => x.kind === kind) ?? (t ? blankTemplate(t) : null);
  };
  const currentTemplate = selection?.type === "template" ? templateFor(selection.kind) : null;

  const errorsById = useMemo(() => {
    const out: Record<string, ConfigErrors> = {};
    for (const c of draft) {
      if (c.detected) continue;
      const e: ConfigErrors = { ...validateConfig(c, draft), ...missingParams(c) };
      if (Object.keys(missingParams(c)).length) delete e.command;
      if (hasErrors(e)) out[c.id] = e;
    }
    return out;
  }, [draft]);
  const invalid = Object.keys(errorsById).length > 0;
  const errors = (current && errorsById[current.id]) ?? {};

  const replace = (next: RunConfig) => {
    setDraft((d) => upsertConfig(d, next));
    setDirty(true);
  };

  const add = (type: RunConfigTypeContribution) => {
    const folder = selection?.type === "folder" && selection.kind === type.id ? selection.name : null;
    const c = newConfigOfType(type, draft, templateFor(type.id), folder);
    setDraft((d) => [...d, c]);
    setSelection({ type: "config", id: c.id });
    setMode("configs");
    setDirty(true);
  };

  const openAdd = (anchor?: HTMLElement | null) => {
    const r = (anchor ?? addRef.current)?.getBoundingClientRect();
    setAdding(r ? { x: r.left, y: r.bottom + 2 } : { x: window.innerWidth / 2 - 120, y: 120 });
  };

  const duplicate = () => {
    if (!current) return;
    const c = duplicateConfig(current, draft);
    setDraft((d) => [...d, c]);
    setSelection({ type: "config", id: c.id });
    setDirty(true);
  };

  const remove = () => {
    if (selection?.type === "folder") {
      // Removing a folder keeps its configurations (they move up a level), as in IDEA.
      setDraft((d) =>
        d.map((c) =>
          c.kind === selection.kind && c.folder === selection.name ? { ...c, folder: null, detected: false } : c,
        ),
      );
      setExtraFolders((f) => f.filter((x) => !(x.kind === selection.kind && x.name === selection.name)));
      setSelection(null);
      setDirty(true);
      return;
    }
    if (!current || current.detected) return;
    const index = draft.findIndex((c) => c.id === current.id);
    const next = removeConfig(draft, current.id);
    setDraft(next);
    const neighbour = next[Math.min(index, next.length - 1)];
    setSelection(neighbour ? { type: "config", id: neighbour.id } : null);
    setDirty(true);
  };

  const newFolder = () => {
    const kind = current?.kind ?? (selection?.type === "folder" ? selection.kind : null);
    if (!kind) return;
    const name = uniqueFolder(kind, draft, extraFolders);
    setExtraFolders((f) => [...f, { kind, name }]);
    // IDEA moves the selected configuration into the new folder.
    if (current) replace({ ...current, folder: name });
    setSelection({ type: "folder", kind, name });
  };

  const renameFolder = (kind: string, from: string, to: string) => {
    setDraft((d) =>
      d.map((c) => (c.kind === kind && c.folder === from ? { ...c, folder: to || null, detected: false } : c)),
    );
    setExtraFolders((f) => f.map((x) => (x.kind === kind && x.name === from ? { kind, name: to } : x)));
    setSelection({ type: "folder", kind, name: to });
    setDirty(true);
  };

  const move = (delta: -1 | 1) => {
    if (!current) return;
    setDraft((d) => moveConfig(d, current.id, delta));
    setDirty(true);
  };

  const updateTemplate = (next: RunConfig) => {
    setTemplates((list) => [
      ...(list ?? []).filter((t) => t.kind !== next.kind),
      { ...next, id: templateId(next.kind), detected: false },
    ]);
    setTemplatesDirty(true);
  };

  const save = async (andClose: boolean): Promise<boolean> => {
    if (invalid) {
      const firstBad = Object.keys(errorsById)[0];
      if (firstBad) {
        setMode("configs");
        setSelection({ type: "config", id: firstBad });
      }
      return false;
    }
    setSaving(true);
    try {
      if (dirty) await saveUserConfigs(userConfigs(draft));
      if (templatesDirty && templates) await call(commands.runSaveTemplates(templates));
      setDirty(false);
      setTemplatesDirty(false);
      if (andClose) {
        if (current) selectConfig(current.id);
        close();
      }
      return true;
    } catch (e) {
      notifications().notify({
        group: "run",
        level: "error",
        title: "Cannot save run configurations",
        body: e instanceof Error ? e.message : String(e),
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** The dialog's Run / Debug: apply, close and launch the selected configuration. */
  const launch = async (debug: boolean) => {
    if (!current || !(await save(true))) return;
    void executeAction(debug ? "run.debugConfig" : "run.runConfig", current.id);
  };

  const rows = treeRows(draft, extraFolders, collapsed);
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onDrop = (e: DragEvent, kind: string, folder: string | null) => {
    const id = dragged.current;
    dragged.current = null;
    const c = draft.find((x) => x.id === id);
    if (!c || c.kind !== kind) return;
    e.preventDefault();
    replace({ ...c, folder });
  };

  // IDEA: ⌘N / Alt+Insert adds a configuration, ⌥M opens "Modify options".
  const onKeyDown = (e: KeyboardEvent) => {
    const add =
      (letterOf(e) === "N" && !e.altKey && (isMac() ? e.metaKey || e.ctrlKey : e.ctrlKey)) ||
      (e.altKey && e.key === "Insert");
    if (add && mode === "configs") {
      e.preventDefault();
      openAdd();
      return;
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyM" && (current || currentTemplate)) {
      e.preventDefault();
      setModifyRequest((n) => n + 1);
    }
  };

  const templateTypes = runConfigTypes(types).filter((t) => t.id !== COMPOUND);
  const canRemove = selection?.type === "folder" || (!!current && !current.detected);

  return (
    <Dialog
      open
      onClose={close}
      title="Run/Debug Configurations"
      width={860}
      className={styles.editDialog}
      footerStart={
        <span className={styles.footerRun}>
          <Button
            icon="run"
            disabled={!current || saving || invalid || mode !== "configs"}
            onClick={() => void launch(false)}
          >
            <T>Run</T>
          </Button>
          <Button
            icon="debug"
            disabled={!current || saving || invalid || mode !== "configs"}
            onClick={() => void launch(true)}
          >
            <T>Debug</T>
          </Button>
          {invalid && (
            <span className={styles.footerError}>
              <Icon name="error" size={13} /> <T>Fix the highlighted fields</T>
            </span>
          )}
        </span>
      }
      buttons={[
        { label: "OK", role: "default", disabled: saving || invalid, onClick: () => void save(true) },
        { label: "Cancel", role: "cancel" },
        { label: "Apply", disabled: !(dirty || templatesDirty) || saving || invalid, onClick: () => void save(false) },
      ]}
    >
      <div className={styles.editBody} onKeyDown={onKeyDown}>
        <div className={styles.editSidebar}>
          {mode === "configs" ? (
            <>
              <div className={styles.editToolbar} role="toolbar" aria-label={tx("Configurations")}>
                <IconButton
                  ref={addRef}
                  icon="plus"
                  size="small"
                  iconSize={14}
                  title="Add New Configuration"
                  onClick={() => openAdd()}
                />
                <IconButton
                  icon="minus"
                  size="small"
                  iconSize={14}
                  title={
                    selection?.type === "folder"
                      ? "Remove Folder"
                      : current && !current.detected && !current.id.startsWith("user:")
                        ? "Remove Override (restore detected)"
                        : "Remove Configuration"
                  }
                  disabled={!canRemove}
                  onClick={remove}
                />
                <IconButton
                  icon="copy"
                  size="small"
                  iconSize={13}
                  title="Copy Configuration"
                  disabled={!current}
                  onClick={duplicate}
                />
                <IconButton
                  icon="folder"
                  size="small"
                  iconSize={13}
                  title="Create New Folder"
                  disabled={!current && selection?.type !== "folder"}
                  onClick={newFolder}
                />
                <IconButton
                  icon="arrow-up"
                  size="small"
                  iconSize={13}
                  title="Move Up"
                  disabled={!current}
                  onClick={() => move(-1)}
                />
                <IconButton
                  icon="arrow-down"
                  size="small"
                  iconSize={13}
                  title="Move Down"
                  disabled={!current}
                  onClick={() => move(1)}
                />
              </div>
              <div className={styles.editList} role="tree" aria-label={tx("Run configurations")}>
                {rows.map((r) => {
                  if (r.type === "group")
                    return (
                      <button
                        key={r.key}
                        type="button"
                        role="treeitem"
                        aria-expanded={!collapsed.has(r.key)}
                        className={styles.editItem}
                        style={{ paddingLeft: 6 }}
                        onClick={() => toggle(r.key)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => onDrop(e, r.kind, null)}
                      >
                        <Icon name={collapsed.has(r.key) ? "chevron-right" : "chevron-down"} size={12} />
                        <Icon name={r.icon} size={13} className={styles.chooserIcon} />
                        <span className={clsx(styles.chooserName, styles.editGroupName)}>{r.label}</span>
                      </button>
                    );
                  if (r.type === "folder") {
                    const sel = selection?.type === "folder" && selection.kind === r.kind && selection.name === r.name;
                    return (
                      <button
                        key={r.key}
                        type="button"
                        role="treeitem"
                        aria-selected={sel}
                        aria-expanded={!collapsed.has(r.key)}
                        className={clsx(styles.editItem, sel && styles.editItemSelected)}
                        style={{ paddingLeft: 22 }}
                        onClick={() => setSelection({ type: "folder", kind: r.kind, name: r.name })}
                        onDoubleClick={() => toggle(r.key)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => onDrop(e, r.kind, r.name)}
                      >
                        <Icon name={collapsed.has(r.key) ? "chevron-right" : "chevron-down"} size={12} />
                        <Icon name="folder" size={13} className={styles.chooserIcon} />
                        <span className={styles.chooserName}>{r.name}</span>
                      </button>
                    );
                  }
                  const c = r.config;
                  return (
                    <button
                      key={r.key}
                      type="button"
                      role="treeitem"
                      aria-selected={current?.id === c.id}
                      className={clsx(styles.editItem, current?.id === c.id && styles.editItemSelected)}
                      style={{ paddingLeft: r.depth === 2 ? 50 : 34 }}
                      onClick={() => setSelection({ type: "config", id: c.id })}
                      title={commandLine(c)}
                      draggable
                      onDragStart={(e) => {
                        dragged.current = c.id;
                        e.dataTransfer.effectAllowed = "move";
                      }}
                    >
                      <Icon
                        name={configIcon(c)}
                        size={13}
                        className={clsx(styles.chooserIcon, temporary.includes(c.id) && styles.chooserTemporary)}
                      />
                      <span className={styles.chooserName}>{c.name || <T>Unnamed</T>}</span>
                      {c.target && <span className={styles.chooserMuted}>@ {targetName(c, runTargets)}</span>}
                      {errorsById[c.id] && <Icon name="error" size={12} className={styles.failed} label="Invalid" />}
                      {!c.detected && <span className={styles.chooserMuted}>{c.local ? "local" : "user"}</span>}
                    </button>
                  );
                })}
                {draft.length === 0 && (
                  <div className={styles.editEmpty}>
                    <T>No run configurations added.</T>
                    <span>
                      <button type="button" className={styles.noticeLink} onClick={(e) => openAdd(e.currentTarget)}>
                        <T>Add new…</T>
                      </button>{" "}
                      <span className={styles.chooserMuted}>{isMac() ? "⌘N" : "Alt+Insert"}</span>
                    </span>
                  </div>
                )}
              </div>
              <button
                type="button"
                className={clsx(styles.noticeLink, styles.editFooterLink)}
                onClick={() => {
                  setMode("templates");
                  const first = templateTypes[0];
                  setSelection(first ? { type: "template", kind: first.id } : null);
                }}
              >
                <T>Edit configuration templates…</T>
              </button>
            </>
          ) : (
            <>
              <div className={styles.editToolbar}>
                <span className={styles.formSectionTitle}>
                  <T>Templates</T>
                </span>
              </div>
              <div className={styles.editList} role="listbox" aria-label={tx("Configuration templates")}>
                {templateTypes.map((t) => {
                  const sel = selection?.type === "template" && selection.kind === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="option"
                      aria-selected={sel}
                      className={clsx(styles.editItem, sel && styles.editItemSelected)}
                      onClick={() => setSelection({ type: "template", kind: t.id })}
                    >
                      <Icon name={t.icon} size={13} className={styles.chooserIcon} />
                      <span className={styles.chooserName}>{t.label}</span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className={clsx(styles.noticeLink, styles.editFooterLink)}
                onClick={() => {
                  setMode("configs");
                  setSelection(draft[0] ? { type: "config", id: draft[0].id } : null);
                }}
              >
                <T>Back to configurations</T>
              </button>
            </>
          )}
        </div>
        <div className={styles.editForm}>
          {mode === "templates" ? (
            currentTemplate ? (
              <>
                <div className={styles.notice}>
                  <T>New configurations of this type start with these values.</T>
                </div>
                <ConfigForm
                  key={`template:${currentTemplate.kind}`}
                  config={currentTemplate}
                  all={draft}
                  type={typeFor(currentTemplate.kind)}
                  errors={{}}
                  template
                  modifyRequest={modifyRequest}
                  onChange={updateTemplate}
                />
              </>
            ) : (
              <div className={styles.editEmpty}>
                <T>Select a configuration type</T>
              </div>
            )
          ) : current ? (
            <ConfigForm
              key={current.id}
              config={current}
              all={draft}
              type={typeFor(current.kind)}
              errors={errors}
              modifyRequest={modifyRequest}
              onChange={replace}
            />
          ) : selection?.type === "folder" ? (
            <FolderName
              key={`${selection.kind}:${selection.name}`}
              name={selection.name}
              onRename={(to) => renameFolder(selection.kind, selection.name, to)}
            />
          ) : (
            <div className={styles.editEmpty}>
              <button type="button" className={styles.noticeLink} onClick={(e) => openAdd(e.currentTarget)}>
                <T>Add new run configuration…</T>
              </button>
              <T>or select run configuration to edit</T>
            </div>
          )}
        </div>
      </div>
      {adding && <AddConfigPopup anchor={adding} onPick={add} onClose={() => setAdding(null)} />}
    </Dialog>
  );
}

/** Renames on every edit that leaves a name (an emptied field keeps the old one). */
function FolderName({ name, onRename }: { name: string; onRename: (to: string) => void }) {
  const [text, setText] = useState(name);
  return (
    <Field label="Folder name" error={text.trim() ? undefined : "Name is required"}>
      <Input
        aria-label="Folder name"
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() && text.trim() !== name && onRename(text.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim() && text.trim() !== name) {
            e.preventDefault();
            onRename(text.trim());
          }
        }}
      />
    </Field>
  );
}
