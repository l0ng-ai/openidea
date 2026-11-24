/**
 * PyCharm's stub markers: a gutter icon on the functions and classes of a Python module that
 * its stub (`.pyi`) declares too, opening the stub's declaration, and the reverse icon in the
 * stub. The backend finds the counterpart file and matches the declarations (`navPythonStubs`).
 */
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { GutterMarker, ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import {
  iconAreaSource,
  mapLineStart,
  onEditorEvent,
  openCodeLocation,
  whenAllSynced,
  whenSynced,
  type EditorDocContext,
} from "@/editor/api";
import type { RelatedItem } from "@/editor/relatedProviders";
import { call, commands, isCancelled, onIdeEvent, type PythonStubLinks, type StubLink } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { gutterIconMarkup } from "@/ui";
import styles from "./LineMarkers.module.css";

const isPythonFile = (path: string) => path.endsWith(".py") || path.endsWith(".pyi");
const isStub = (path: string) => path.endsWith(".pyi");

const pythonStubLinks = (doc: number): Promise<PythonStubLinks> => call(commands.navPythonStubs(doc));

/** The innermost declaration whose extent holds `line`. */
export function linkAt(links: readonly StubLink[], line: number): StubLink | null {
  let best: StubLink | null = null;
  for (const link of links)
    if (link.extent.start.line <= line && line <= link.extent.end.line)
      if (!best || link.extent.start.line >= best.extent.start.line) best = link;
  return best;
}

/** Related Symbol (and Navigate › Stub / Implementation): the counterpart of the caret's declaration, else the file. */
export async function stubRelatedItems(doc: number, path: string, line: number): Promise<RelatedItem[]> {
  if (!isPythonFile(path)) return [];
  await whenAllSynced();
  const found = await pythonStubLinks(doc);
  if (!found.counterpart) return [];
  const link = linkAt(found.links, line);
  return [
    {
      path: found.counterpart,
      ...(link && { line: link.target.start.line, col: link.target.start.col, label: link.name }),
      group: isStub(path) ? tx("Implementation") : tx("Stub"),
    },
  ];
}

interface StubMark {
  pos: number;
  link: StubLink;
}

interface StubMarks {
  counterpart: string | null;
  marks: StubMark[];
  /** Where the counterpart was looked for; a change to one of them refreshes the markers. */
  candidates: ReadonlySet<string>;
}

const setStubMarks = StateEffect.define<StubMarks>();

const stubMarksField = StateField.define<StubMarks>({
  create: () => ({ counterpart: null, marks: [], candidates: new Set() }),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setStubMarks)) return effect.value;
    if (!tr.docChanged || !value.marks.length) return value;
    return { ...value, marks: value.marks.map((m) => ({ ...m, pos: mapLineStart(tr, m.pos) })) };
  },
});

class StubMarker extends GutterMarker {
  constructor(
    readonly title: string,
    readonly path: string,
    readonly target: StubLink["target"]["start"],
  ) {
    super();
  }

  // The DOM is kept while this holds, so the target is part of it: a moved or other counterpart
  // must render a new button.
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof StubMarker &&
      other.title === this.title &&
      other.path === this.path &&
      other.target.line === this.target.line &&
      other.target.col === this.target.col
    );
  }

  override toDOM(): Node {
    const button = document.createElement("button");
    button.type = "button";
    button.className = styles.stubMarker ?? "";
    button.dataset.pythonStub = "";
    button.title = this.title;
    button.setAttribute("aria-label", this.title);
    button.innerHTML = gutterIconMarkup("gutter-navigate") ?? "";
    // Keep the caret where it was; the click navigates, so the icon also works from the keyboard.
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openCodeLocation(this.path, { line: this.target.line, col: this.target.col });
    });
    return button;
  }
}

function markerTitle(stub: boolean, name: string, counterpart: string): string {
  const file = basename(counterpart);
  return stub ? tx`Implementation of ${name} in ${file}` : tx`Stub of ${name} in ${file}`;
}

/** Marker sets by field value: the icon area asks on every view update (caret moves, scrolling). */
const markerSets = new WeakMap<StubMarks, RangeSet<GutterMarker>>();

function stubMarkers(value: StubMarks, stub: boolean): RangeSet<GutterMarker> {
  let set = markerSets.get(value);
  if (!set) {
    const { counterpart, marks } = value;
    set = counterpart
      ? RangeSet.of(
          marks.map(({ pos, link }) =>
            new StubMarker(markerTitle(stub, link.name, counterpart), counterpart, link.target.start).range(pos),
          ),
          true,
        )
      : RangeSet.empty;
    markerSets.set(value, set);
  }
  return set;
}

export function pythonStubGutter(ctx: EditorDocContext): Extension {
  if (ctx.doc < 0 || ctx.virtual || !isPythonFile(ctx.path)) return [];
  const stub = isStub(ctx.path);
  return [
    stubMarksField,
    ViewPlugin.fromClass(
      class {
        private timer: ReturnType<typeof setTimeout> | undefined;
        private generation = 0;
        private off: () => void;

        constructor(readonly view: EditorView) {
          this.schedule(0);
          // Edits to the counterpart, and files created, changed or removed where it may be.
          const watched = (path: string) => this.view.state.field(stubMarksField).candidates.has(path);
          const offEditor = onEditorEvent((e) => {
            if ((e.type === "docChanged" || e.type === "docSaved") && watched(e.path)) this.schedule(500);
          });
          const offFiles = onIdeEvent("fsChanged", (e) => {
            if ([...e.created, ...e.modified, ...e.removed].some(watched)) this.schedule(500);
          });
          this.off = () => {
            offEditor();
            offFiles();
          };
        }

        update(update: ViewUpdate) {
          if (update.docChanged) this.schedule();
        }

        schedule(delay = 500) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => void this.refresh(), delay);
        }

        async refresh() {
          const generation = ++this.generation;
          const current = this.view.state.doc;
          try {
            await whenSynced(this.view);
            if (generation !== this.generation || this.view.state.doc !== current) return;
            const found = await pythonStubLinks(ctx.doc);
            if (generation !== this.generation || this.view.state.doc !== current) return;
            const seen = new Set<number>();
            const marks: StubMark[] = [];
            for (const link of found.links) {
              const line = link.range.start.line;
              if (line >= current.lines || seen.has(line)) continue;
              seen.add(line);
              marks.push({ pos: current.line(line + 1).from, link });
            }
            const candidates = new Set(found.candidates);
            this.view.dispatch({ effects: setStubMarks.of({ counterpart: found.counterpart, marks, candidates }) });
          } catch (e) {
            if (!isCancelled(e) && generation === this.generation) console.debug("[Python stubs]", e);
          }
        }

        destroy() {
          this.off();
          clearTimeout(this.timer);
          this.generation++;
        }
      },
    ),
    iconAreaSource.of({
      order: 55,
      markers: (view) => stubMarkers(view.state.field(stubMarksField), stub),
    }),
  ];
}
