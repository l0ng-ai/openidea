/**
 * Gutter ▶ icons in Dockerfiles (`FROM` → run / build the image) and Compose
 * files (`services:` → up all, each service → up it). As in IDEA they start
 * temporary Dockerfile / Docker Compose run configurations through `run.runConfig`.
 */
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { gutterIconMarkup, showContextMenu, type MenuItem } from "@/ui";
import { fileTargets, isComposeFile, isDockerfile, targetTitle, type DockerTarget } from "./compose";
import { gutterActions } from "./runTypes";
import styles from "./Services.module.css";

interface Placed {
  target: DockerTarget;
  pos: number;
}

const setTargets = StateEffect.define<Placed[]>();

const targetsField = StateField.define<Placed[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTargets)) return e.value;
    if (!tr.docChanged) return value;
    return value.map((p) => ({ ...p, pos: tr.state.doc.lineAt(tr.changes.mapPos(p.pos, -1)).from }));
  },
});

function place(state: EditorState, path: string): Placed[] {
  return fileTargets(path, state.doc.toString())
    .filter((t) => t.line < state.doc.lines)
    .map((target) => ({ target, pos: state.doc.line(target.line + 1).from }));
}

function menu(target: DockerTarget, path: string): MenuItem[] {
  const root = useProject.getState().project?.root ?? null;
  return gutterActions(target, path, root).map(({ title, config }, i) => ({
    label: title,
    icon: i === 0 ? "run" : "build-project",
    run: () => void executeAction("run.runConfig", { config, temporary: true }),
  }));
}

class Marker extends GutterMarker {
  constructor(
    readonly target: DockerTarget,
    readonly path: string,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof Marker &&
      other.path === this.path &&
      targetTitle(other.target, other.path) === targetTitle(this.target, this.path)
    );
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = styles.marker ?? "";
    el.title = targetTitle(this.target, this.path);
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", el.title);
    el.innerHTML = gutterIconMarkup(this.target.kind === "composeAll" ? "gutter-run-all" : "gutter-run") ?? "";
    return el;
  }
}

export function dockerGutter(ctx: EditorDocContext): Extension {
  const path = ctx.path;
  if (ctx.virtual || !(isDockerfile(path) || isComposeFile(path))) return [];
  const detector = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      constructor(readonly view: EditorView) {
        this.schedule(0);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(300);
      }
      schedule(delay: number) {
        clearTimeout(this.timer);
        this.timer = setTimeout(
          () => this.view.dispatch({ effects: setTargets.of(place(this.view.state, path)) }),
          delay,
        );
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
  return [
    targetsField,
    detector,
    gutter({
      // Shares the run gutter's class so "Show run icons" hides these too.
      class: `${styles.gutter} cm-openidea-gutter-run`,
      markers: (view) =>
        RangeSet.of(
          view.state.field(targetsField).map((p) => new Marker(p.target, path).range(p.pos)),
          true,
        ),
      initialSpacer: () => new Marker({ kind: "composeAll", line: 0 }, path),
      domEventHandlers: {
        mousedown: (view, block, event) => {
          const placed = view.state.field(targetsField).find((p) => p.pos === block.from);
          if (!placed || (event as MouseEvent).button !== 0) return false;
          const el = (event.target as HTMLElement).closest?.(`.${styles.marker}`) ?? (event.target as HTMLElement);
          const rect = el.getBoundingClientRect();
          event.preventDefault();
          showContextMenu({ x: rect.left, y: rect.bottom + 2 }, menu(placed.target, path));
          return true;
        },
      },
    }),
  ];
}
