/**
 * Gutter ▶ icons in Dockerfiles (`FROM` → run / build the image) and Compose
 * files (`services:` → up all, each service → up it). As in IDEA they start
 * temporary Dockerfile / Docker Compose run configurations through `run.runConfig`.
 */
import { Compartment, RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { gutterIconMarkup, showContextMenu, type MenuItem } from "@/ui";
import {
  fileTargets,
  COMPOSE_SCAN_LIMIT,
  isComposeFile,
  isDockerfile,
  isYamlFile,
  noteComposeContent,
  targetTitle,
  useComposeFiles,
  type DockerTarget,
} from "./compose";
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
  const prefix = state.doc.sliceString(0, Math.min(state.doc.length, COMPOSE_SCAN_LIMIT));
  noteComposeContent(path, prefix);
  if (!isDockerfile(path) && !isComposeFile(path, prefix)) return [];
  const text = state.doc.toString();
  return fileTargets(path, text)
    .filter((t) => t.line < state.doc.lines)
    .map((target) => ({ target, pos: state.doc.line(target.line + 1).from }));
}

function menu(target: DockerTarget, path: string): MenuItem[] {
  const root = useProject.getState().project?.root ?? null;
  const actions = gutterActions(target, path, root);
  const items: MenuItem[] = actions.map(({ title, config }, i) => ({
    label: title,
    icon: i === 0 ? "run" : "build-project",
    run: () => void executeAction("run.runConfig", { config, temporary: true }),
  }));
  if (actions[0]) {
    items.push(
      { kind: "separator" },
      {
        label: "Modify Run Configuration…",
        icon: "edit",
        run: () => void executeAction("run.createConfig", actions[0]!.config),
      },
    );
  }
  return items;
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
    const el = document.createElement("button");
    el.type = "button";
    el.className = styles.marker ?? "";
    el.title = targetTitle(this.target, this.path);
    el.setAttribute("aria-label", el.title);
    el.innerHTML = gutterIconMarkup(this.target.kind === "composeAll" ? "gutter-run-all" : "gutter-run") ?? "";
    el.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = el.getBoundingClientRect();
      showContextMenu({ x: rect.left, y: rect.bottom + 2 }, menu(this.target, this.path));
    };
    return el;
  }
}

function makeGutter(path: string): Extension {
  return gutter({
    // Shares the run gutter's class so "Show run icons" hides these too.
    class: `${styles.gutter} cm-openidea-gutter-run`,
    markers: (view) =>
      RangeSet.of(
        view.state.field(targetsField).map((p) => new Marker(p.target, path).range(p.pos)),
        true,
      ),
    initialSpacer: () => new Marker({ kind: "composeAll", line: 0 }, path),
  });
}

export function dockerGutter(ctx: EditorDocContext): Extension {
  const path = ctx.path;
  if (ctx.virtual || !(isDockerfile(path) || isYamlFile(path))) return [];
  const gutterSlot = new Compartment();
  const gutterExt = makeGutter(path);
  let hasGutter = false;
  const detector = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      unsubscribe: () => void;
      constructor(readonly view: EditorView) {
        this.schedule(0);
        this.unsubscribe = useComposeFiles.subscribe((s, prev) => {
          if (s.overrides[path] !== prev.overrides[path]) this.schedule(0);
        });
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(300);
      }
      schedule(delay: number) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const placed = place(this.view.state, path);
          const wantGutter = placed.length > 0;
          const effects: StateEffect<unknown>[] = [setTargets.of(placed)];
          if (wantGutter !== hasGutter) {
            hasGutter = wantGutter;
            effects.push(gutterSlot.reconfigure(wantGutter ? gutterExt : []));
          }
          this.view.dispatch({ effects });
        }, delay);
      }
      destroy() {
        clearTimeout(this.timer);
        this.unsubscribe();
      }
    },
  );
  return [targetsField, gutterSlot.of([]), detector];
}
