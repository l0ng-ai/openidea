import { clearSnippet, nextSnippetField, snippet } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  MapMode,
  StateEffect,
  StateField,
  Text,
  type ChangeSpec,
  type SelectionRange,
  type Transaction,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type Command } from "@codemirror/view";
import { isExternalChange } from "@/editor/api";

export interface SnippetSite {
  from: number;
  to: number;
  snippet: string;
}

interface ActiveFields {
  groups: readonly EditorSelection[];
  active: number;
  linked?: { field: number; firstRangeIndices: readonly number[]; mainIndex: number };
}

const setFields = StateEffect.define<ActiveFields | null>();
const fieldMark = Decoration.mark({ class: "cm-snippetField" });
const fieldCursor = Decoration.widget({
  widget: new (class extends WidgetType {
    toDOM() {
      const span = document.createElement("span");
      span.className = "cm-snippetFieldPosition";
      return span;
    }
    ignoreEvent() {
      return false;
    }
  })(),
});

function contains(range: SelectionRange, from: number, to: number): boolean {
  return range.from <= from && to <= range.to;
}

function fieldSelection(value: ActiveFields, group: EditorSelection, field: number): EditorSelection {
  const { linked } = value;
  if (linked?.field !== field) return group;
  return EditorSelection.create(
    linked.firstRangeIndices.map((index) => group.ranges[index]!),
    linked.mainIndex,
  );
}

const fields = StateField.define<ActiveFields | null>({
  create: () => null,
  update(value, tr) {
    const next = tr.effects.find((e) => e.is(setFields));
    if (next) return next.value;
    if (!value) return null;
    const { active } = value;
    let { groups } = value;
    if (tr.docChanged) {
      const mapped: EditorSelection[] = [];
      for (const [field, group] of groups.entries()) {
        const ranges = [];
        for (const range of group.ranges) {
          const from = tr.changes.mapPos(range.from, -1, MapMode.TrackDel);
          const to = tr.changes.mapPos(range.to, 1, MapMode.TrackDel);
          if (from === null || to === null) return null;
          ranges.push(EditorSelection.range(from, to));
        }
        const selection = EditorSelection.create(ranges, group.mainIndex);
        if (value.linked?.field === field && selection.ranges.length !== group.ranges.length) return null;
        mapped.push(selection);
      }
      groups = mapped;
    }
    if (tr.selection) {
      const current = fieldSelection(value, groups[active]!, active).ranges;
      if (!tr.selection.ranges.every((range) => current.some((field) => contains(field, range.from, range.to))))
        return null;
    }
    return groups === value.groups ? value : { ...value, groups };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (v) =>
      v
        ? Decoration.set(
            v.groups.flatMap((g) => g.ranges.map((r) => (r.empty ? fieldCursor : fieldMark).range(r.from, r.to))),
            true,
          )
        : Decoration.none,
    ),
});

// Mirror the linked field in the same transaction so the edits undo together.
const mirrorLinkedField = EditorState.transactionFilter.of((tr) => {
  const value = tr.startState.field(fields, false);
  const linked = value?.linked;
  if (
    !value ||
    linked?.field !== value.active ||
    !tr.docChanged ||
    isExternalChange(tr) ||
    tr.isUserEvent("undo") ||
    tr.isUserEvent("redo") ||
    tr.effects.some((effect) => effect.is(setFields))
  )
    return tr;

  const { ranges } = value.groups[value.active]!;
  const edited = new Set<number>();
  let outside = false;
  tr.changes.iterChangedRanges((from, to) => {
    const site = linked.firstRangeIndices.findIndex((index) => contains(ranges[index]!, from, to));
    if (site >= 0) edited.add(site);
    else outside = true;
  }, true);
  if (outside) return [tr, { effects: setFields.of(null) }];

  const changes: ChangeSpec[] = [];
  for (const site of edited) {
    const index = linked.firstRangeIndices[site]!;
    const primary = ranges[index]!;
    const insert = tr.newDoc.sliceString(tr.changes.mapPos(primary.from, -1), tr.changes.mapPos(primary.to, 1));
    for (const mirror of ranges.slice(index + 1, linked.firstRangeIndices[site + 1])) {
      changes.push({ from: tr.changes.mapPos(mirror.from), to: tr.changes.mapPos(mirror.to), insert });
    }
  }
  return changes.length ? [tr, { changes, sequential: true }] : tr;
});

export const hasMulticaretSnippet = (state: EditorState) => !!state.field(fields, false);

export function multicaretFieldMoved(tr: Transaction): number | undefined {
  return tr.effects.find((e) => e.is(setFields))?.value?.active;
}

export const clearMulticaretSnippet: Command = (view) => {
  if (!hasMulticaretSnippet(view.state)) return false;
  view.dispatch({ effects: setFields.of(null) });
  return true;
};

function selectField(view: EditorView, value: ActiveFields, active: number): boolean {
  const group = value.groups[active];
  if (!group) return false;
  view.dispatch({
    selection: fieldSelection(value, group, active),
    effects: setFields.of(active === value.groups.length - 1 ? null : { ...value, active }),
    scrollIntoView: true,
  });
  return true;
}

export const moveMulticaretField =
  (direction: 1 | -1): Command =>
  (view) => {
    const value = view.state.field(fields, false);
    return value ? selectField(view, value, value.active + direction) : false;
  };

export const multicaretSnippetExtension = [
  fields,
  mirrorLinkedField,
  EditorView.domEventHandlers({
    mousedown(event, view) {
      const value = view.state.field(fields);
      if (!value || event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const index = value.groups.findIndex((g) => g.ranges.some((r) => r.from <= pos && pos <= r.to));
      return index !== value.active && selectField(view, value, index);
    },
  }),
];

/** Ask CodeMirror to render each snippet in its line's indentation and expose its tab stops. */
function instantiate(source: EditorState, site: SnippetSite) {
  const line = source.doc.lineAt(site.from);
  const from = site.from - line.from;
  const to = site.to - line.from;
  let state = EditorState.create({
    doc: source.doc.slice(line.from, source.doc.lineAt(site.to).to),
    selection: EditorSelection.cursor(to),
    extensions: [EditorState.allowMultipleSelections.of(true), indentUnit.of(source.facet(indentUnit))],
  });
  const dispatch = (tr: Transaction) => {
    state = tr.state;
  };
  let insert = Text.empty;
  snippet(site.snippet)(
    {
      state,
      dispatch: (tr) => {
        tr.changes.iterChanges((_from, _to, _start, _end, text) => {
          insert = text;
        });
        dispatch(tr);
      },
    },
    null,
    from,
    to,
  );
  const groups = [];
  do {
    groups.push(state.selection);
  } while (nextSnippetField({ state, dispatch }));
  return { from: site.from, to: site.to, offset: from, insert, groups };
}

export function applyMulticaretSnippet(view: EditorView, sites: readonly SnippetSite[], linkedField = -1) {
  const { state } = view;
  const entries = sites.map((site) => instantiate(state, site));
  const changes = state.changes(entries.map(({ from, to, insert }) => ({ from, to, insert })));
  let linked: ActiveFields["linked"];
  const groups = entries[0]!.groups.map((_, field) => {
    let main = 0;
    const firstRangeIndices: number[] = [];
    const ranges: SelectionRange[] = [];
    entries.forEach((entry, i) => {
      const group = entry.groups[field]!;
      const offset = changes.mapPos(entry.from, -1) - entry.offset;
      if (i < state.selection.mainIndex) main += group.ranges.length;
      if (field === linkedField) firstRangeIndices.push(ranges.length);
      ranges.push(...group.ranges.map((r) => EditorSelection.range(r.from + offset, r.to + offset)));
    });
    if (field === linkedField) linked = { field, firstRangeIndices, mainIndex: state.selection.mainIndex };
    return EditorSelection.create(ranges, main);
  });
  const value = { groups, active: 0, linked };
  clearSnippet(view);
  view.dispatch({
    changes,
    selection: fieldSelection(value, groups[0]!, 0),
    effects: setFields.of(groups.length > 1 ? value : null),
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  });
}
