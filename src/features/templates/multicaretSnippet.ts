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
  type Transaction,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type Command } from "@codemirror/view";

export interface SnippetSite {
  from: number;
  to: number;
  snippet: string;
}

interface ActiveFields {
  groups: readonly EditorSelection[];
  active: number;
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
      for (const group of groups) {
        const ranges = [];
        for (const range of group.ranges) {
          const from = tr.changes.mapPos(range.from, -1, MapMode.TrackDel);
          const to = tr.changes.mapPos(range.to, 1, MapMode.TrackDel);
          if (from === null || to === null) return null;
          ranges.push(EditorSelection.range(from, to));
        }
        mapped.push(EditorSelection.create(ranges, group.mainIndex));
      }
      groups = mapped;
    }
    const current = groups[active]!.ranges;
    if (tr.selection && !tr.selection.ranges.every((r) => current.some((f) => f.from <= r.from && r.to <= f.to)))
      return null;
    return groups === value.groups ? value : { groups, active };
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
  const selection = value.groups[active];
  if (!selection) return false;
  view.dispatch({
    selection,
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
    doc: line.text,
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

export function applyMulticaretSnippet(view: EditorView, sites: readonly SnippetSite[]) {
  const { state } = view;
  const entries = sites.map((site) => instantiate(state, site));
  const changes = state.changes(entries.map(({ from, to, insert }) => ({ from, to, insert })));
  const groups = entries[0]!.groups.map((_, field) => {
    let main = 0;
    const ranges = entries.flatMap((entry, i) => {
      const group = entry.groups[field]!;
      const offset = changes.mapPos(entry.from, -1) - entry.offset;
      if (i < state.selection.mainIndex) main += group.ranges.length;
      return group.ranges.map((r) => EditorSelection.range(r.from + offset, r.to + offset));
    });
    return EditorSelection.create(ranges, main);
  });
  clearSnippet(view);
  view.dispatch({
    changes,
    selection: groups[0]!,
    effects: setFields.of(groups.length > 1 ? { groups, active: 0 } : null),
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  });
}
