/**
 * Code navigation in editors: the links of the file answer Go to Declaration,
 * ⌘-click and middle click (through the `CONTRIBUTED_DEFINITION` language
 * data; the language server is still asked elsewhere) and get the ⌘-hover
 * underline; the markers are gutter icons that open their targets. Both follow
 * their lines through unsaved edits until the next save re-runs the providers.
 */
import { EditorState, RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter } from "@codemirror/view";
import {
  CONTRIBUTED_DEFINITION,
  CONTRIBUTED_LINK_AT,
  type ContributedDefinition,
  type ContributedLinkAt,
  type EditorDocContext,
} from "@/editor/api";
import { caretAnchor } from "@/editor/lsp/popupStore";
import { tx } from "@/platform/i18n";
import { isVirtualUri } from "@/platform/virtualDocs";
import { gutterIconMarkup } from "@/ui";
import styles from "../http-client/HttpClient.module.css";
import type { NavLink, NavMarker } from "./model";
import { useCodeNavigation } from "./store";
import { openTargets } from "./targets";

/** Gutter icon of a marker without `icon`, or with an unknown one. */
export const DEFAULT_MARKER_ICON = "arrow-right";

export interface PlacedLink {
  /** Document offsets in the current state. */
  from: number;
  to: number;
  link: NavLink;
}

export interface PlacedMarker {
  /** Offset of the line start. */
  pos: number;
  marker: NavMarker;
}

/** Links as offsets of `doc` (columns clipped to the line; empty or out-of-range ones dropped). */
export function placeLinks(doc: Text, links: readonly NavLink[]): PlacedLink[] {
  const out: PlacedLink[] = [];
  for (const link of links) {
    if (link.line < 1 || link.line > doc.lines) continue;
    const line = doc.line(link.line);
    const from = line.from + Math.min(link.from, line.length);
    const to = line.from + Math.min(link.to, line.length);
    if (to > from) out.push({ from, to, link });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Markers at their line starts in `doc` (lines past the end dropped), one entry per marker. */
export function placeMarkers(doc: Text, markers: readonly NavMarker[]): PlacedMarker[] {
  return markers
    .filter((m) => m.line >= 1 && m.line <= doc.lines)
    .map((marker) => ({ pos: doc.line(marker.line).from, marker }))
    .sort((a, b) => a.pos - b.pos);
}

/** The narrowest placed link containing `pos` (end inclusive). */
export function placedLinkAt(links: readonly PlacedLink[], pos: number): PlacedLink | null {
  let best: PlacedLink | null = null;
  for (const l of links) if (l.from <= pos && pos <= l.to && (!best || l.to - l.from < best.to - best.from)) best = l;
  return best;
}

const setLinks = StateEffect.define<PlacedLink[]>();
const setMarkers = StateEffect.define<PlacedMarker[]>();

const linksField = StateField.define<PlacedLink[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLinks)) return e.value;
    if (!tr.docChanged || !value.length) return value;
    return value
      .map((l) => ({ ...l, from: tr.changes.mapPos(l.from, 1), to: tr.changes.mapPos(l.to, -1) }))
      .filter((l) => l.to > l.from);
  },
});

const markersField = StateField.define<PlacedMarker[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarkers)) return e.value;
    if (!tr.docChanged || !value.length) return value;
    return value.map((m) => ({ ...m, pos: tr.state.doc.lineAt(tr.changes.mapPos(m.pos, -1)).from }));
  },
});

const sameLinks = (a: readonly PlacedLink[], b: readonly PlacedLink[]) =>
  a.length === b.length && a.every((l, i) => l.from === b[i]!.from && l.to === b[i]!.to && l.link === b[i]!.link);
const sameMarkers = (a: readonly PlacedMarker[], b: readonly PlacedMarker[]) =>
  a.length === b.length && a.every((m, i) => m.pos === b[i]!.pos && m.marker === b[i]!.marker);

function tooltipOf(m: NavMarker): string {
  return m.tooltip || m.title || tx`Navigate`;
}

class NavGutterMarker extends GutterMarker {
  constructor(readonly marker: NavMarker) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof NavGutterMarker &&
      other.marker.icon === this.marker.icon &&
      tooltipOf(other.marker) === tooltipOf(this.marker) &&
      (other.marker.targets ?? []).length === (this.marker.targets ?? []).length
    );
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = styles.runMarker ?? "";
    const tooltip = tooltipOf(this.marker);
    el.title = tooltip;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", tooltip);
    el.innerHTML =
      (this.marker.icon && gutterIconMarkup(this.marker.icon)) || gutterIconMarkup(DEFAULT_MARKER_ICON) || "";
    return el;
  }
}

export function codeNavigationExtension(ctx: EditorDocContext): Extension {
  if (ctx.virtual || isVirtualUri(ctx.path)) return [];
  const path = ctx.path;
  const follower = ViewPlugin.fromClass(
    class {
      unsubscribe: () => void;
      constructor(readonly view: EditorView) {
        this.unsubscribe = useCodeNavigation.subscribe((s, prev) => {
          if (s.files[path] !== prev.files[path]) this.refresh();
        });
        // The answer may already be there (a split pane opened the file earlier).
        setTimeout(() => this.refresh(), 0);
      }
      refresh() {
        if (!this.view.dom.isConnected) return;
        const nav = useCodeNavigation.getState().files[path];
        const links = placeLinks(this.view.state.doc, nav?.links ?? []);
        const markers = placeMarkers(this.view.state.doc, nav?.markers ?? []);
        const effects: StateEffect<unknown>[] = [];
        if (!sameLinks(this.view.state.field(linksField), links)) effects.push(setLinks.of(links));
        if (!sameMarkers(this.view.state.field(markersField), markers)) effects.push(setMarkers.of(markers));
        if (effects.length) this.view.dispatch({ effects });
      }
      destroy() {
        this.unsubscribe();
      }
    },
  );
  const definition: ContributedDefinition = (view, pos) => {
    const hit = placedLinkAt(view.state.field(linksField, false) ?? [], pos);
    if (!hit) return false;
    void openTargets(hit.link.targets, caretAnchor(view, hit.from), hit.link.title);
    return true;
  };
  const linkRange: ContributedLinkAt = (state, pos) => {
    const hit = placedLinkAt(state.field(linksField, false) ?? [], pos);
    return hit ? { from: hit.from, to: hit.to } : null;
  };
  return [
    linksField,
    markersField,
    follower,
    EditorState.languageData.of(() => [{ [CONTRIBUTED_DEFINITION]: definition, [CONTRIBUTED_LINK_AT]: linkRange }]),
    gutter({
      class: `${styles.runGutter} cm-openidea-gutter-codeNavigation`,
      markers: (view) =>
        RangeSet.of(
          view.state.field(markersField).map((m) => new NavGutterMarker(m.marker).range(m.pos)),
          true,
        ),
      domEventHandlers: {
        mousedown: (view, block, event) => {
          const e = event as MouseEvent;
          if (e.button !== 0) return false;
          const onLine = view.state.field(markersField).filter((m) => m.pos === block.from);
          if (!onLine.length) return false;
          e.preventDefault();
          const target = e.target instanceof Element ? e.target : null;
          const rect = (target?.closest(`.${styles.runMarker}`) ?? target)?.getBoundingClientRect();
          const anchor = rect ? { x: rect.left, y: rect.bottom + 2 } : { x: e.clientX, y: e.clientY };
          const targets = onLine.flatMap((m) => m.marker.targets ?? []);
          const title = onLine.length === 1 ? onLine[0]!.marker.title : null;
          void openTargets(targets, anchor, title);
          return true;
        },
      },
    }),
  ];
}
