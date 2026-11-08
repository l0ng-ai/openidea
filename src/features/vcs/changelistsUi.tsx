/** Change list dialogs: New / Edit Changelist, Move to Another Changelist, delete. */
import { useState } from "react";
import { Checkbox, Dialog, Input, Select, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import {
  activeList,
  addList,
  checksForList,
  editList,
  moveFiles,
  relOf,
  removeList,
  setActiveList,
  updateChangelists,
  useChangelists,
  validateListName,
} from "./changelists";
import { groupOf } from "./changes";
import { useCommit } from "./commitStore";
import { isModalCommit, openCommit } from "./commitUi";
import { confirmDialog, openDialog } from "./dialogs";
import { fileCount, stripSlash } from "./model";
import { useVcs } from "./store";
import styles from "./common.module.css";
import { tx } from "@/platform/i18n";

interface FormValue {
  name: string;
  comment: string;
  active: boolean;
}

function ChangelistForm({
  value,
  onChange,
  error,
  activeDisabled,
}: {
  value: FormValue;
  onChange: (v: FormValue) => void;
  error: string | null;
  activeDisabled?: boolean;
}) {
  return (
    <div className={styles.form}>
      <label className={styles.fieldLabel} htmlFor="openidea-cl-name">
        <T>Name:</T>
      </label>
      <Input
        id="openidea-cl-name"
        data-autofocus
        value={value.name}
        invalid={!!value.name && !!error}
        onChange={(e) => onChange({ ...value, name: e.target.value })}
      />
      {value.name && error && <div className={styles.error}>{error}</div>}
      <label className={styles.fieldLabel} htmlFor="openidea-cl-comment">
        <T>Comment:</T>
      </label>
      <textarea
        id="openidea-cl-comment"
        className={styles.textarea}
        rows={3}
        value={value.comment}
        onChange={(e) => onChange({ ...value, comment: e.target.value })}
      />
      <Checkbox
        checked={value.active}
        disabled={activeDisabled}
        onChange={(active) => onChange({ ...value, active })}
        label="Set active"
      />
    </div>
  );
}

/** New Changelist…; `moveRels` are moved into the new list (Move to Another Changelist › New). */
export function newChangelist(moveRels: readonly string[] = []) {
  openDialog((close) => <NewChangelistDialog moveRels={moveRels} onClose={close} />);
}

function NewChangelistDialog({ moveRels, onClose }: { moveRels: readonly string[]; onClose: () => void }) {
  const state = useChangelists((s) => s.state);
  const [value, setValue] = useState<FormValue>({ name: "", comment: "", active: false });
  const error = validateListName(state, value.name);
  const create = () => {
    if (error) return;
    onClose();
    updateChangelists((s) => {
      const r = addList(s, value.name, { comment: value.comment, makeActive: value.active });
      return moveRels.length ? moveFiles(r.state, moveRels, r.id) : r.state;
    });
  };
  return (
    <Dialog
      open
      title="New Changelist"
      onClose={onClose}
      width={420}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: create },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <ChangelistForm value={value} onChange={setValue} error={error} />
    </Dialog>
  );
}

export function editChangelist(id: string) {
  const list = useChangelists.getState().state.lists.find((l) => l.id === id);
  if (!list) return;
  openDialog((close) => <EditChangelistDialog id={id} onClose={close} />);
}

function EditChangelistDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useChangelists((s) => s.state);
  const list = state.lists.find((l) => l.id === id);
  const [value, setValue] = useState<FormValue>({
    name: list?.name ?? "",
    comment: list?.comment ?? "",
    active: state.active === id,
  });
  const error = validateListName(state, value.name, id);
  const save = () => {
    if (error) return;
    onClose();
    updateChangelists((s) => {
      const edited = editList(s, id, value.name, value.comment);
      return value.active ? setActiveList(edited, id) : edited;
    });
  };
  return (
    <Dialog
      open
      title="Edit Changelist"
      onClose={onClose}
      width={420}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: save },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <ChangelistForm value={value} onChange={setValue} error={error} activeDisabled={state.active === id} />
    </Dialog>
  );
}

export async function deleteChangelist(id: string) {
  const state = useChangelists.getState().state;
  const list = state.lists.find((l) => l.id === id);
  if (!list) return;
  if (id === state.active) {
    notifications().notify({
      group: "vcs",
      level: "info",
      title: "The active changelist cannot be deleted",
      body: "Make another changelist active first.",
    });
    return;
  }
  const count = Object.values(state.files ?? {}).filter((l) => l === id).length;
  if (count) {
    const ok = await confirmDialog({
      title: "Delete Changelist",
      message:
        count === 1
          ? tx`Changelist '${list.name}' contains ${count} change. It will be moved to '${activeList(state).name}'. Delete the changelist?`
          : tx`Changelist '${list.name}' contains ${count} changes. They will be moved to '${activeList(state).name}'. Delete the changelist?`,
      okLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
  }
  updateChangelists((s) => removeList(s, id));
}

export function setActiveChangelist(id: string) {
  updateChangelists((s) => setActiveList(s, id));
}

/**
 * Commit… on a change list: include exactly its changes and focus the message — under
 * the modal interface it is in the Commit dialog, which this opens.
 */
export function commitChangelist(id: string) {
  const { status, root } = useVcs.getState();
  const checks = checksForList(status, root ?? "", useChangelists.getState().state, id);
  useCommit.setState((s) => ({ checks, tab: "changes", focusTick: s.focusTick + 1 }));
  if (isModalCommit()) openCommit();
}

/**
 * Commit File…: include exactly these changes (absolute paths) and focus the message —
 * under the modal interface it is in the Commit dialog, which this opens.
 */
export function commitFiles(paths: readonly string[]) {
  const chosen = new Set(paths.map(stripSlash));
  const checks = new Map<string, "all" | "none">();
  for (const f of useVcs.getState().status)
    if (groupOf(f) === "changes") checks.set(f.path, chosen.has(stripSlash(f.path)) ? "all" : "none");
  useCommit.setState((s) => ({ checks, tab: "changes", focusTick: s.focusTick + 1 }));
  if (isModalCommit()) openCommit();
}

/** Moves files (absolute paths) to a list. */
export function moveToChangelist(paths: readonly string[], id: string) {
  const rels = paths.map(relOf);
  updateChangelists((s) => moveFiles(s, rels, id));
}

/** Move to Another Changelist… (F6 in the Commit tool window). */
export function showMoveToChangelist(paths: readonly string[]) {
  if (!paths.length) {
    notifications().notify({ group: "vcs", level: "info", title: "Select changes to move" });
    return;
  }
  const rels = paths.map(relOf);
  openDialog((close) => (
    <TargetListDialog
      title="Move Changes to Another Changelist"
      hint={fileCount(paths.length)}
      exclude={paths.map(
        (p) => useChangelists.getState().state.files?.[relOf(p)] ?? useChangelists.getState().state.active,
      )}
      onClose={close}
      onChoose={(id) => updateChangelists((s) => moveFiles(s, rels, id))}
    />
  ));
}

/**
 * Select Target Changelist (Undo Commit): an existing list, or a new one named
 * `suggestedName`. Resolves the chosen list's id (created if new), or null.
 */
export function chooseTargetChangelist(suggestedName: string): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: string | null = null;
    openDialog((close) => (
      <TargetListDialog
        title="Select Target Changelist"
        suggestedName={suggestedName}
        onClose={() => {
          close();
          resolve(chosen);
        }}
        onChoose={(id) => {
          chosen = id;
        }}
      />
    ));
  });
}

function TargetListDialog({
  title,
  hint,
  exclude = [],
  suggestedName = "",
  onChoose,
  onClose,
}: {
  title: string;
  hint?: string;
  /** Lists the changes are all in already (not offered). */
  exclude?: readonly string[];
  suggestedName?: string;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const state = useChangelists((s) => s.state);
  const [currentLists] = useState(() => new Set(exclude));
  const others = state.lists.filter((l) => !(currentLists.size === 1 && currentLists.has(l.id)));
  const [mode, setMode] = useState<"existing" | "new">(others.length ? "existing" : "new");
  const [target, setTarget] = useState((others.find((l) => l.id === state.active) ?? others[0])?.id ?? state.active);
  const [value, setValue] = useState<FormValue>({ name: suggestedName, comment: "", active: false });
  const error = mode === "new" ? validateListName(state, value.name) : null;
  const choose = () => {
    if (error) return;
    if (mode === "new") {
      let id = "";
      updateChangelists((s) => {
        const r = addList(s, value.name, { comment: value.comment, makeActive: value.active });
        id = r.id;
        return r.state;
      });
      onChoose(id);
    } else {
      onChoose(target);
    }
    onClose();
  };
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      width={440}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: choose },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form} role="radiogroup" aria-label={tx("Target changelist")}>
        {hint && <div className={styles.hint}>{hint}</div>}
        <label className={styles.radioRow}>
          <input
            type="radio"
            name="target"
            checked={mode === "existing"}
            disabled={!others.length}
            onChange={() => setMode("existing")}
          />
          <span className={styles.radioText}>
            <T>Existing changelist:</T>
          </span>
        </label>
        <Select
          value={target}
          disabled={mode !== "existing"}
          aria-label="Existing changelist"
          onChange={setTarget}
          options={others.map((l) => ({ value: l.id, label: l.id === state.active ? tx`${l.name} (active)` : l.name }))}
        />
        <label className={styles.radioRow}>
          <input type="radio" name="target" checked={mode === "new"} onChange={() => setMode("new")} />
          <span className={styles.radioText}>
            <T>New changelist:</T>
          </span>
        </label>
      </div>
      {mode === "new" && <ChangelistForm value={value} onChange={setValue} error={error} />}
    </Dialog>
  );
}
