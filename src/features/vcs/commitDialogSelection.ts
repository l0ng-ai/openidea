/** The Commit dialog's own changes-tree selection, used only while that tree has keyboard focus. */
export interface CommitDialogSelection {
  paths: string[];
  keys: string[];
}

let published: CommitDialogSelection | null = null;

/** The dialog's ChangesTree publishes its selection here; `null` once it unmounts. */
export function setCommitDialogSelection(selection: CommitDialogSelection | null) {
  published = selection;
}

/**
 * The dialog tree's selection while it owns the keyboard focus, else `null`.
 *
 * The modal Commit dialog shares `useCommit.selection` with the Git window's Local
 * Changes tab, so that store can hold a selection the dialog's tree does not show.
 * Selection-based actions therefore read this snapshot instead, and only while the
 * focus is inside the dialog's changes tree.
 */
export function commitDialogTreeSelection(): CommitDialogSelection | null {
  if (published === null) return null;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (!(active instanceof Element) || !active.closest('[data-changes-tree="dialog"]')) return null;
  return published;
}
