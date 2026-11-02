/**
 * The merge editor's model, after IntelliJ's `MergeConflictModel`: the result starts as the
 * base, and every change the sides made to it waits there to be accepted from either side,
 * ignored or resolved. A change is settled once both sides are; a conflict can take one
 * side, then the other (which is appended), as in IntelliJ.
 */
import { invertedEffects } from "@codemirror/commands";
import {
  ChangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import { mergeChanges, type ChangeKind } from "./mergeDiff3";

export type MergeSide = "left" | "right";

export interface MergeChange {
  /** Where the change sits in the result; follows the document as it is edited. */
  from: number;
  to: number;
  kind: ChangeKind;
  left: string;
  base: string;
  right: string;
  /** Where the change is in the left and the right version, for the side panes. */
  leftRange: readonly [number, number];
  rightRange: readonly [number, number];
  /** The word-level merge of a conflict whose sides changed different words. */
  auto: string | null;
  /** The sides that were accepted or ignored. */
  done: { readonly left: boolean; readonly right: boolean };
  /** One side of a conflict was accepted and the other is still to be decided. */
  oneside: boolean;
}

export const isResolved = (c: MergeChange) => c.done.left && c.done.right;
export const isConflict = (c: MergeChange) => c.kind === "conflict";
/** Whether `side` differs from the base here. */
export const changesSide = (c: MergeChange, side: MergeSide) =>
  c.kind === "both" || c.kind === "conflict" || c.kind === side;

const textOf = (c: MergeChange, side: MergeSide) => (side === "left" ? c.left : c.right);
const opposite = (side: MergeSide): MergeSide => (side === "left" ? "right" : "left");
const settled = (c: MergeChange): MergeChange => ({ ...c, done: { left: true, right: true } });

interface Placed {
  index: number;
  change: MergeChange;
}

/** Puts a change in the model; its positions are those of the document after the transaction. */
const setChange = StateEffect.define<Placed>({
  map: ({ index, change }, mapping) => ({
    index,
    change: { ...change, from: mapping.mapPos(change.from, -1), to: mapping.mapPos(change.to, 1) },
  }),
});

/** The changes of the merge, in document order. Typing at the edge of a change stays inside it. */
export const mergeField = StateField.define<readonly MergeChange[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged
      ? value.map((c) => ({ ...c, from: tr.changes.mapPos(c.from, -1), to: tr.changes.mapPos(c.to, 1) }))
      : value;
    for (const e of tr.effects) {
      if (!e.is(setChange)) continue;
      if (next === value) next = [...value];
      (next as MergeChange[])[e.value.index] = e.value.change;
    }
    return next;
  },
});

/**
 * Undo and redo of the editor's history bring back the text only; this brings back the
 * state of the changes with it, so an undone resolution can be made again.
 */
export const mergeHistory = invertedEffects.of((tr) => {
  const before = tr.startState.field(mergeField);
  return tr.effects
    .filter((e) => e.is(setChange))
    .map((e) => setChange.of({ index: e.value.index, change: before[e.value.index]! }));
});

/** The result's starting text, the base, and the changes waiting in it. */
export function startMerge(left: string, base: string, right: string): { text: string; changes: MergeChange[] } {
  const found = mergeChanges(left, base, right);
  // Too different to compare line by line: the whole file is one change.
  const whole = (): MergeChange[] => {
    if (left === base && right === base) return [];
    const kind: ChangeKind = left === right ? "both" : left === base ? "right" : right === base ? "left" : "conflict";
    return [
      {
        from: 0,
        to: base.length,
        kind,
        left,
        base,
        right,
        auto: null,
        leftRange: [0, left.length],
        rightRange: [0, right.length],
        done: { left: false, right: false },
        oneside: false,
      },
    ];
  };
  const changes: MergeChange[] =
    found?.map((c) => ({
      from: c.baseFrom,
      to: c.baseTo,
      kind: c.kind,
      left: c.left,
      base: c.base,
      right: c.right,
      leftRange: [c.leftFrom, c.leftTo],
      rightRange: [c.rightFrom, c.rightTo],
      auto: c.auto,
      done: { left: false, right: false },
      oneside: false,
    })) ?? whole();
  return { text: base, changes };
}

/** A change's new state, and the edit of the result that goes with it. */
interface Plan {
  index: number;
  next: MergeChange;
  edit?: { from: number; to: number; insert: string };
}

/** The transaction applying `plans`, or null when there is nothing to do. */
function commit(state: EditorState, plans: readonly Plan[], userEvent: string): TransactionSpec | null {
  if (!plans.length) return null;
  const changes = ChangeSet.of(
    plans.flatMap((p) => (p.edit ? [p.edit] : [])),
    state.doc.length,
  );
  return {
    changes,
    effects: plans.map((p) =>
      setChange.of({
        index: p.index,
        change: { ...p.next, from: changes.mapPos(p.next.from, -1), to: changes.mapPos(p.next.to, 1) },
      }),
    ),
    userEvent,
  };
}

const replace = (c: MergeChange, insert: string) => ({ from: c.from, to: c.to, insert });

/**
 * Takes the text of `side` for the change (IntelliJ's `replaceChange`). A conflict stays open
 * for the other side unless `resolve` settles it, or the other side has nothing to add.
 */
function accept(doc: Text, c: MergeChange, index: number, side: MergeSide, resolve: boolean): Plan | null {
  if (c.done[side]) return null;
  if (!changesSide(c, side)) return { index, next: settled(c) };
  const text = textOf(c, side);
  if (!isConflict(c)) return { index, next: settled(c), edit: replace(c, text) };
  if (!c.oneside) {
    const partial = !resolve && textOf(c, opposite(side)) !== "";
    return {
      index,
      edit: replace(c, text),
      next: partial ? { ...c, oneside: true, done: { ...c.done, [side]: true } } : settled(c),
    };
  }
  // The other side's text is already there; this one follows it, on a line of its own.
  const there = doc.sliceString(c.from, c.to);
  const insert = (there !== "" && !there.endsWith("\n") ? "\n" : "") + text;
  return {
    index,
    edit: { from: c.to, to: c.to, insert },
    next: resolve ? settled(c) : { ...c, done: { ...c.done, [side]: true } },
  };
}

/** Ignores the change of `side` (IntelliJ's `ignoreChange`): the result keeps what it has. */
function ignore(c: MergeChange, index: number, side: MergeSide | null): Plan {
  return { index, next: isConflict(c) && side ? { ...c, done: { ...c.done, [side]: true } } : settled(c) };
}

/** Whether the user edited the change's text in the result: it is then left alone by automatic resolving. */
const edited = (doc: Text, c: MergeChange) => doc.sliceString(c.from, c.to) !== c.base;

/** IntelliJ's `canResolveChangeAutomatically`: `base` stands for "whatever fits". */
export function canResolveAutomatically(doc: Text, c: MergeChange, side: MergeSide | "base"): boolean {
  if (edited(doc, c)) return false;
  if (isConflict(c)) return side === "base" && c.auto !== null && !c.done.left && !c.done.right;
  return !isResolved(c) && (side === "base" || changesSide(c, side));
}

function resolveAutomatically(doc: Text, c: MergeChange, index: number, side: MergeSide | "base"): Plan | null {
  if (!canResolveAutomatically(doc, c, side)) return null;
  if (isConflict(c)) return { index, next: settled(c), edit: replace(c, c.auto!) };
  const from = side === "base" ? (changesSide(c, "left") ? "left" : "right") : side;
  return { index, next: settled(c), edit: replace(c, textOf(c, from)) };
}

/** What the user can do with the changes in the merge editor. */
export type MergeAction =
  | { type: "accept"; side: MergeSide; resolve: boolean }
  | { type: "ignore"; side: MergeSide | null }
  | { type: "auto"; side: MergeSide | "base" };

/** Whether `action` applies to the change now (the enabled state of IntelliJ's actions). */
export function canApply(doc: Text, c: MergeChange, action: MergeAction): boolean {
  switch (action.type) {
    case "accept":
      return !c.done[action.side];
    case "ignore":
      return action.side ? !c.done[action.side] : !isResolved(c);
    case "auto":
      return canResolveAutomatically(doc, c, action.side);
  }
}

function plan(doc: Text, c: MergeChange, index: number, action: MergeAction): Plan | null {
  switch (action.type) {
    case "accept":
      return accept(doc, c, index, action.side, action.resolve);
    case "ignore":
      return ignore(c, index, action.side);
    case "auto":
      return resolveAutomatically(doc, c, index, action.side);
  }
}

/** Applies `action` to the changes at `indexes` that it applies to. */
export function applyTo(state: EditorState, indexes: readonly number[], action: MergeAction): TransactionSpec | null {
  const changes = state.field(mergeField);
  const plans: Plan[] = [];
  for (const i of indexes) {
    const c = changes[i];
    const p = c && canApply(state.doc, c, action) ? plan(state.doc, c, i, action) : null;
    if (p) plans.push(p);
  }
  return commit(state, plans, "input.resolve");
}

/**
 * The indexes of the changes whose text, `range(change)` in `doc`, lies in the lines `from`–`to`.
 * A change that adds lines has an empty range: it is where its offset is. A caret at the start
 * of the line after a change is not in the change.
 */
function selected(
  state: EditorState,
  doc: Text,
  from: number,
  to: number,
  range: (c: MergeChange) => readonly [number, number] | null,
): number[] {
  const start = doc.lineAt(from).from;
  const end = Math.min(doc.length, doc.lineAt(to).to + 1);
  const out: number[] = [];
  state.field(mergeField).forEach((c, i) => {
    const r = range(c);
    if (!r) return;
    const [a, b] = r;
    const hit = a === b ? a >= start && (a < end || a === doc.length) : a < end && b > start;
    if (hit) out.push(i);
  });
  return out;
}

/** The changes whose text lies in the lines `from`–`to` of the result. */
export const changesIn = (state: EditorState, from: number, to: number) =>
  selected(state, state.doc, from, to, (c) => [c.from, c.to]);

/** The changes of a side pane's version that lie in the lines `from`–`to` of that pane. */
export const changesInSide = (state: EditorState, side: MergeSide, doc: Text, from: number, to: number) =>
  selected(state, doc, from, to, (c) => (changesSide(c, side) ? (side === "left" ? c.leftRange : c.rightRange) : null));

const allIndexes = (state: EditorState) => state.field(mergeField).map((_, i) => i);

/** Apply Non-Conflicting Changes from `side` (`base`: from either). */
export function applyNonConflicting(state: EditorState, side: MergeSide | "base"): TransactionSpec | null {
  const changes = state.field(mergeField);
  const indexes = allIndexes(state).filter((i) => !isConflict(changes[i]!));
  return applyTo(state, indexes, { type: "auto", side });
}

export const hasNonConflicting = (state: EditorState, side: MergeSide | "base") =>
  state.field(mergeField).some((c) => !isConflict(c) && canResolveAutomatically(state.doc, c, side));

/** Resolve Simple Conflicts: every change that can be resolved without a decision. */
export const resolveSimple = (state: EditorState) => applyTo(state, allIndexes(state), { type: "auto", side: "base" });

export const hasSimple = (state: EditorState) =>
  state.field(mergeField).some((c) => canResolveAutomatically(state.doc, c, "base"));

/** Revert Conflict Resolution: the settled changes go back to the base. */
export function revertResolved(state: EditorState): TransactionSpec | null {
  const plans: Plan[] = [];
  state.field(mergeField).forEach((c, index) => {
    if (!isResolved(c)) return;
    plans.push({
      index,
      edit: replace(c, c.base),
      next: { ...c, oneside: false, done: { left: false, right: false } },
    });
  });
  return commit(state, plans, "input.resolve");
}

/** The changes still to be settled. */
export const unresolved = (state: EditorState) => state.field(mergeField).filter((c) => !isResolved(c));

/** What the toolbar needs to know: how much is left, and which of its commands do something. */
export interface MergeSummary {
  pending: number;
  conflicts: number;
  /** Apply Non-Conflicting Changes from the left side, from either side, from the right side. */
  left: boolean;
  all: boolean;
  right: boolean;
  /** Resolve Simple Conflicts. */
  simple: boolean;
  /** Revert Conflict Resolution. */
  revert: boolean;
}

export function summarize(state: EditorState): MergeSummary {
  const open = unresolved(state);
  return {
    pending: open.length,
    conflicts: open.filter(isConflict).length,
    left: hasNonConflicting(state, "left"),
    all: hasNonConflicting(state, "base"),
    right: hasNonConflicting(state, "right"),
    simple: hasSimple(state),
    revert: state.field(mergeField).some(isResolved),
  };
}
