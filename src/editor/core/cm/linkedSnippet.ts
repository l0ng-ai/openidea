import {
  clearSnippet,
  closeCompletion,
  completionStatus,
  pickedCompletion,
  snippet,
  type Completion,
} from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  MapMode,
  Prec,
  StateEffect,
  StateField,
  Text,
  type ChangeSpec,
  type Transaction,
} from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType, type Command } from "@codemirror/view";
import { isExternalChange } from "@/editor/api";

interface SnippetSite {
  from: number;
  to: number;
  snippet: string;
}

interface SnippetRange {
  from: number;
  to: number;
  field: number;
}

interface Segment extends SnippetRange {
  site: number;
  primary: boolean;
}

interface ActiveSnippet {
  segments: readonly Segment[];
  active: number;
  last: number;
  mainSite: number;
  completion: boolean;
}

const setSnippet = StateEffect.define<ActiveSnippet | null>();
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

function primarySegments(value: ActiveSnippet, field = value.active) {
  return value.segments.filter((segment) => segment.field === field && segment.primary);
}

function contains(range: SnippetRange, from: number, to: number): boolean {
  return range.from <= from && to <= range.to;
}

function selectionInField(value: ActiveSnippet, selection: EditorSelection): boolean {
  const primaries = primarySegments(value);
  return selection.ranges.every(({ from, to }) => primaries.some((segment) => contains(segment, from, to)));
}

const fields = StateField.define<ActiveSnippet | null>({
  create: () => null,
  update(value, tr) {
    const next = tr.effects.find((effect) => effect.is(setSnippet));
    if (next) return next.value;
    if (!value) return null;
    if (tr.docChanged) {
      const segments: Segment[] = [];
      for (const segment of value.segments) {
        const from = tr.changes.mapPos(segment.from, -1, MapMode.TrackDel);
        const to = tr.changes.mapPos(segment.to, 1, MapMode.TrackDel);
        if (from === null || to === null || from < (segments.at(-1)?.to ?? 0)) return null;
        segments.push({ ...segment, from, to });
      }
      value = { ...value, segments };
    }
    return tr.selection && !selectionInField(value, tr.selection) ? null : value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) =>
      value
        ? Decoration.set(
            value.segments.map(({ from, to }) => (from === to ? fieldCursor : fieldMark).range(from, to)),
            true,
          )
        : Decoration.none,
    ),
});

// Keep the edit and its mirrors in one history entry.
const mirrorEdits = EditorState.transactionFilter.of((tr) => {
  const value = tr.startState.field(fields, false);
  if (
    !value ||
    !tr.docChanged ||
    isExternalChange(tr) ||
    tr.isUserEvent("undo") ||
    tr.isUserEvent("redo") ||
    tr.effects.some((effect) => effect.is(setSnippet))
  )
    return tr;

  const primaries = primarySegments(value);
  const edited = new Map<Segment, number>();
  let outside = false;
  let touchesOtherSegment = false;
  tr.changes.iterChangedRanges((from, to, newFrom, newTo) => {
    const segment = primaries.find((range) => contains(range, from, to));
    if (segment) edited.set(segment, (edited.get(segment) ?? 0) + (newTo - newFrom) - (to - from));
    else {
      outside = true;
      touchesOtherSegment ||= value.segments.some((range) => from <= range.to && to >= range.from);
    }
  }, true);
  if (outside) return edited.size || touchesOtherSegment ? [tr, { effects: setSnippet.of(null) }] : tr;

  const changes: ChangeSpec[] = [];
  const replacements = new Map<number, Text>();
  let typedOffset = 0;
  let mirrorOffset = 0;
  // Map in source order so neighboring stops keep their own boundaries even when they touch.
  const segments = value.segments.map((segment) => {
    const start = segment.from + typedOffset;
    const from = start + mirrorOffset;
    let length = segment.to - segment.from;
    const delta = edited.get(segment);
    if (delta !== undefined) {
      length += delta;
      replacements.set(segment.site, tr.newDoc.slice(start, start + length));
      typedOffset += delta;
    } else if (segment.field === value.active && !segment.primary) {
      const insert = replacements.get(segment.site);
      if (insert && !insert.eq(tr.newDoc.slice(start, start + length))) {
        changes.push({ from: start, to: start + length, insert });
        mirrorOffset += insert.length - length;
        length = insert.length;
      }
    }
    return { ...segment, from, to: from + length };
  });
  const mirrors = ChangeSet.of(changes, tr.newDoc.length);
  const next = { ...value, segments };
  const staysInField = selectionInField(next, tr.newSelection.map(mirrors));
  return [tr, { changes: mirrors, effects: setSnippet.of(staysInField ? next : null), sequential: true }];
});

function clearLinkedSnippet(view: EditorView): boolean {
  if (!view.state.field(fields, false)) return false;
  view.dispatch({ effects: setSnippet.of(null) });
  return true;
}

export const escapeSnippet: Command = (view) => {
  const sel = view.state.selection;
  if (sel.ranges.some((r) => !r.empty)) {
    closeCompletion(view);
    view.dispatch({
      selection: EditorSelection.create(
        sel.ranges.map((r) => EditorSelection.cursor(r.head)),
        sel.mainIndex,
      ),
    });
    return true;
  }
  if (completionStatus(view.state) === "active") return closeCompletion(view);
  return clearLinkedSnippet(view) || clearSnippet(view);
};

function fieldSelection(value: ActiveSnippet, field: number): EditorSelection {
  return EditorSelection.create(
    primarySegments(value, field).map(({ from, to }) => EditorSelection.range(from, to)),
    value.mainSite,
  );
}

function selectField(view: EditorView, value: ActiveSnippet, active: number): boolean {
  if (active < 0 || active > value.last) return false;
  view.dispatch({
    selection: fieldSelection(value, active),
    effects: setSnippet.of(active === value.last ? null : { ...value, active }),
    scrollIntoView: true,
  });
  return true;
}

export function hasLinkedSnippetField(state: EditorState, direction: 1 | -1): boolean {
  const value = state.field(fields, false);
  return !!value && (direction === 1 ? value.active < value.last : value.active > 0);
}

export const nextLiveSnippetField: Command = (view) => {
  const value = view.state.field(fields, false);
  return !!value && !value.completion && selectField(view, value, value.active + 1);
};

const linkedSnippetExtension = [
  fields,
  mirrorEdits,
  Prec.highest(
    keymap.of([
      {
        key: "Tab",
        run: (view) => {
          const value = view.state.field(fields);
          return (
            !!value &&
            !view.state.readOnly &&
            completionStatus(view.state) !== "active" &&
            selectField(view, value, value.active + 1)
          );
        },
        shift: (view) => {
          const value = view.state.field(fields);
          return !!value && selectField(view, value, value.active - 1);
        },
      },
      { key: "Escape", run: (view) => !!view.state.field(fields) && escapeSnippet(view) },
    ]),
  ),
  EditorView.domEventHandlers({
    mousedown(event, view) {
      const value = view.state.field(fields);
      if (!value || event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const segment = value.segments.find((range) => contains(range, pos, pos));
      return !!segment && segment.field !== value.active && selectField(view, value, segment.field);
    },
  }),
];

function codeMirrorSnippet(tr: Transaction): { active: number; ranges: SnippetRange[] } | undefined {
  // CodeMirror exposes the native snippet's unmerged ranges through its state effect.
  return tr.effects
    .map(({ value }) => value)
    .find((value) => {
      return value && typeof value.active === "number" && Array.isArray(value.ranges);
    });
}

export function snippetFieldMoved(tr: Transaction): number | undefined {
  const linked = tr.effects.find((effect) => effect.is(setSnippet));
  if (linked) return linked.value?.completion ? undefined : linked.value?.active;
  return codeMirrorSnippet(tr)?.active;
}

/** Render with CodeMirror to keep its snippet syntax and indentation. */
function instantiate(source: EditorState, site: SnippetSite) {
  const line = source.doc.lineAt(site.from);
  const from = site.from - line.from;
  const to = site.to - line.from;
  const state = EditorState.create({
    doc: source.doc.slice(line.from, source.doc.lineAt(site.to).to),
    selection: EditorSelection.cursor(to),
    extensions: [indentUnit.of(source.facet(indentUnit))],
  });
  let insert = Text.empty;
  let ranges: SnippetRange[] = [];
  // An extra anonymous stop exposes the range effect even when a snippet has only one field.
  snippet(site.snippet + "#{}")(
    {
      state,
      dispatch(tr) {
        tr.changes.iterChanges((_from, _to, _start, _end, text) => {
          insert = text;
        });
        ranges = codeMirrorSnippet(tr)?.ranges ?? [];
      },
    },
    null,
    from,
    to,
  );
  const end = ranges.at(-1);
  const seen = new Set<number>();
  const segments = ranges.slice(0, -1).map((range) => {
    const primary = !seen.has(range.field);
    seen.add(range.field);
    return { ...range, primary };
  });
  return { ...site, offset: from, insert, segments, end };
}

export function applySnippet(view: EditorView, sites: readonly SnippetSite[], completion: Completion | null = null) {
  const { state } = view;
  const { main } = state.selection;
  const entries = sites.map((site) =>
    instantiate(state, { ...site, to: sites.length === 1 && site.to === main.from ? main.to : site.to }),
  );
  if (entries.length === 1 && entries[0]!.segments.every((segment) => segment.primary)) {
    const { snippet: source, from, to } = sites[0]!;
    clearLinkedSnippet(view);
    snippet(source)(view, completion, from, to);
    return;
  }

  const changes = state.changes(entries.map(({ from, to, insert }) => ({ from, to, insert })));
  let last = Math.max(...entries[0]!.segments.map(({ field }) => field));
  const needsEnd = entries.some(({ segments }) =>
    segments.some((segment) => segment.field === last && !segment.primary),
  );
  if (needsEnd) last++;
  const segments = entries.flatMap((entry, site) => {
    const offset = changes.mapPos(entry.from, -1) - entry.offset;
    const ranges = [...entry.segments];
    if (needsEnd && entry.end) ranges.push({ ...entry.end, primary: true });
    return ranges.map((segment) => ({ ...segment, site, from: segment.from + offset, to: segment.to + offset }));
  });
  const value = {
    segments,
    active: 0,
    last,
    mainSite: sites.length === 1 ? 0 : state.selection.mainIndex,
    completion: !!completion,
  };
  clearSnippet(view);
  view.dispatch({
    changes,
    selection: fieldSelection(value, 0),
    effects: [
      setSnippet.of(last > 0 ? value : null),
      ...(state.field(fields, false) === undefined ? [StateEffect.appendConfig.of(linkedSnippetExtension)] : []),
    ],
    annotations: completion ? pickedCompletion.of(completion) : isolateHistory.of("full"),
    userEvent: completion ? "input.complete" : undefined,
    scrollIntoView: true,
  });
}
