/** Change list dialogs: New / Edit Changelist, Move to Another Changelist, delete. */
import { useId, useRef, useState, type ChangeEvent } from "react";
import { Checkbox, Dialog, IconButton, Input, Popup, SelectListbox, T, type SelectOption } from "@/ui";
import type { InputProps } from "@/ui/Input";
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
import { changedPathsUnder, groupOf } from "./changes";
import { addToVcs, addToVcsTargets } from "./changeOps";
import { useCommit } from "./commitStore";
import { isModalCommit, openCommit } from "./commitUi";
import { confirmDialog, openDialog } from "./dialogs";
import { fileCount, stripSlash } from "./model";
import { refreshNow, useVcs } from "./store";
import formStyles from "./ChangelistForm.module.css";
import styles from "./common.module.css";
import { tx } from "@/platform/i18n";

interface FormValue {
  name: string;
  comment: string;
  active: boolean;
}

export function ChangelistNamePicker({
  field,
  options,
  newName,
  onChoose,
}: {
  field: InputProps;
  options: readonly SelectOption[];
  newName: boolean;
  onChoose: (name: string) => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        ref={anchor}
        className={formStyles.picker}
        data-invalid={field.invalid || undefined}
        data-open={open || undefined}
      >
        <Input
          {...field}
          ref={input}
          variant="bare"
          autoSelect
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" || event.nativeEvent.isComposing || !options.length) return;
            event.preventDefault();
            setOpen(true);
          }}
        />
        {newName && (
          <span className={formStyles.newName}>
            <T>New</T>
          </span>
        )}
        <IconButton
          icon="chevron-down"
          title="Choose changelist"
          size="small"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={field.disabled || !options.length}
          onClick={() => {
            input.current?.focus();
            setOpen(!open);
          }}
        />
      </div>
      <Popup open={open} onClose={() => setOpen(false)} anchor={anchor} matchWidth role="presentation">
        <SelectListbox
          options={options}
          value={typeof field.value === "string" ? field.value : null}
          aria-label="Target changelist"
          onChoose={(name) => {
            onChoose(name);
            setOpen(false);
          }}
        />
      </Popup>
    </>
  );
}

function ChangelistForm({
  value,
  onChange,
  error,
  activeDisabled,
  nameOptions,
  existingDetails,
  hint,
}: {
  value: FormValue;
  onChange: (v: FormValue) => void;
  error: string | null;
  activeDisabled?: boolean;
  nameOptions?: readonly SelectOption[];
  existingDetails?: Pick<FormValue, "comment" | "active">;
  hint?: string;
}) {
  const id = useId();
  const errorId = value.name && error ? `${id}-error` : undefined;
  const nameField = {
    id: `${id}-name`,
    "data-autofocus": "",
    value: value.name,
    invalid: !!errorId,
    "aria-describedby": errorId,
    onChange: (e: ChangeEvent<HTMLInputElement>) => onChange({ ...value, name: e.target.value }),
  };
  return (
    <div className={formStyles.form}>
      {hint && <div className={formStyles.hint}>{hint}</div>}
      <label className={formStyles.nameLabel} htmlFor={`${id}-name`}>
        <T>Name:</T>
      </label>
      <div className={formStyles.nameField}>
        {nameOptions ? (
          <ChangelistNamePicker
            field={nameField}
            options={nameOptions}
            newName={!existingDetails && !error}
            onChoose={(name) => onChange({ ...value, name })}
          />
        ) : (
          <Input {...nameField} />
        )}
        {errorId && (
          <div className={styles.error} id={errorId}>
            {error}
          </div>
        )}
      </div>
      <label className={formStyles.commentLabel} htmlFor={`${id}-comment`}>
        <T>Comment:</T>
      </label>
      <textarea
        id={`${id}-comment`}
        className={styles.textarea}
        rows={4}
        value={existingDetails?.comment ?? value.comment}
        readOnly={!!existingDetails}
        onChange={(e) => onChange({ ...value, comment: e.target.value })}
      />
      <Checkbox
        className={formStyles.active}
        checked={existingDetails?.active ?? value.active}
        disabled={activeDisabled || !!existingDetails}
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
      width={500}
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
      width={500}
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
  openCommit();
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

/**
 * Adds files (absolute paths) to a list. Unversioned ones are added to Git first
 * (IDEA's Unversioned Files behaviour), so the list gets them as changes.
 */
export async function addToChangelist(paths: readonly string[], id: string) {
  if (!paths.length) return;
  const untracked = addToVcsTargets(paths, useVcs.getState().status);
  if (untracked.length) {
    await addToVcs(untracked);
    // `runOp` refreshes without waiting; changes only join the list once tracked.
    await refreshNow();
  }
  const files = changedPathsUnder(paths, useVcs.getState().status);
  if (files.length) moveToChangelist(files, id);
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
  const [value, setValue] = useState<FormValue>(() => ({
    name: (others.find((l) => l.id === state.active) ?? others[0])?.name ?? suggestedName,
    comment: "",
    active: false,
  }));
  const target = others.find((l) => l.name.toLowerCase() === value.name.trim().toLowerCase());
  const error = target ? null : validateListName(state, value.name);
  const nameOptions: SelectOption[] = others.map((l) => ({
    value: l.name,
    label: l.id === state.active ? tx`${l.name} (active)` : l.name,
    verbatim: true,
  }));
  if (!validateListName(state, suggestedName)) {
    nameOptions.unshift({ value: suggestedName, label: suggestedName, detail: "New", verbatim: true });
  }
  const choose = () => {
    if (error) return;
    if (target) {
      onChoose(target.id);
    } else {
      let id = "";
      updateChangelists((s) => {
        const r = addList(s, value.name, { comment: value.comment, makeActive: value.active });
        id = r.id;
        return r.state;
      });
      onChoose(id);
    }
    onClose();
  };
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      width={500}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: choose },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <ChangelistForm
        value={value}
        onChange={setValue}
        error={error}
        hint={hint}
        nameOptions={nameOptions}
        existingDetails={target ? { comment: target.comment ?? "", active: target.id === state.active } : undefined}
      />
    </Dialog>
  );
}
