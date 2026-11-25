/**
 * Go to declaration in `pom.xml`: ⌘/Ctrl-click (or ⌘B) on a `${property}` reference
 * opens the `<properties>` entry that defines it — the POM's own, else one inherited
 * along the parent chain (a parent POM outside the project opens from the local
 * repository, read-only as a plain file). A dependency, plugin or `<parent>` opens the
 * artifact's own POM (a project module first, then the local repository). Unversioned
 * declarations also get IDEA's "Navigate to managing dependency" gutter icon, which
 * opens the exact `<dependencyManagement>` / `<pluginManagement>` entry — including
 * one in a parent POM or imported BOM — that controls the version. The backend does
 * the resolution; here only cheap eligibility is computed, so the ⌘-hover underline
 * stays out of the rest of the file and no marker promises a target that does not exist.
 */
import { EditorState, RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  CONTRIBUTED_DEFINITION,
  iconAreaSource,
  mapLineStart,
  onEditorEvent,
  whenSynced,
  type ContributedDefinition,
  type EditorDocContext,
} from "@/editor/api";
import { showHint } from "@/editor/lsp/hint";
import { isMavenPom } from "@/platform/buildFiles";
import { tx } from "@/platform/i18n";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  onIdeEvent,
  type PomGoto,
  type PomManagedDeclaration,
  type RequestId,
} from "@/platform/ipc";
import { gutterIconMarkup } from "@/ui";
import { editorService } from "@/workbench/contributions";
import styles from "./PomNavigation.module.css";

/** The `${property}` reference covering `at`, if any (clicking the `$` counts). */
export function propertyRefAt(text: string, at: number): { from: number; to: number } | null {
  const open = text.startsWith("${", at) ? at : text.lastIndexOf("${", at - 1);
  if (open < 0) return null;
  const close = text.indexOf("}", open + 2);
  if (close < 0 || close < at) return null;
  return { from: open, to: close + 1 };
}

/** Whether an opener of `name` before `at` has no closer of it yet (POM elements do not nest). */
function inside(name: string, text: string, at: number): boolean {
  const before = text.slice(0, at);
  const count = (re: RegExp) => (before.match(re) ?? []).length;
  return count(new RegExp(`<${name}[\\s>]`, "g")) > count(new RegExp(`</${name}\\s*>`, "g"));
}

/**
 * Whether `at` may sit in a `<dependency>` / `<plugin>` / `<parent>` element: an
 * eligibility test only (a `<dependency>` inside a comment counts too) — what the
 * element resolves to is the backend's answer.
 */
export function inArtifactElement(text: string, at: number): boolean {
  return inside("dependency", text, at) || inside("plugin", text, at) || inside("parent", text, at);
}

export interface ManagedMark {
  pos: number;
  link: PomManagedDeclaration;
}

/** Places the backend's 0-based lines in a document, one icon per declaration line. */
export function placeManagedMarks(doc: Text, links: readonly PomManagedDeclaration[]): ManagedMark[] {
  const seen = new Set<number>();
  const out: ManagedMark[] = [];
  for (const link of links) {
    if (!Number.isInteger(link.line) || link.line < 0 || link.line >= doc.lines || seen.has(link.line)) continue;
    seen.add(link.line);
    out.push({ pos: doc.line(link.line + 1).from, link });
  }
  return out;
}

const setManagedMarks = StateEffect.define<ManagedMark[]>();

const managedMarksField = StateField.define<ManagedMark[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setManagedMarks)) return effect.value;
    if (!tr.docChanged || !value.length) return value;
    return value.map((mark) => ({ ...mark, pos: mapLineStart(tr, mark.pos) }));
  },
});

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

function managedTitle(link: PomManagedDeclaration): string {
  const location = `${fileName(link.target.path)}:${link.target.range.start.line + 1}`;
  return link.version ? tx`Managed version ${link.version} in ${location}` : tx`Managed in ${location}`;
}

class ManagedMarker extends GutterMarker {
  constructor(
    readonly mark: ManagedMark,
    readonly open: () => void,
  ) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    const a = this.mark.link;
    const b = other instanceof ManagedMarker ? other.mark.link : null;
    return (
      !!b &&
      a.version === b.version &&
      a.target.path === b.target.path &&
      a.target.range.start.line === b.target.range.start.line &&
      a.target.range.start.col === b.target.range.start.col
    );
  }

  override toDOM(): Node {
    const button = document.createElement("button");
    button.type = "button";
    button.className = styles.managedMarker ?? "";
    button.dataset.managedDependency = "";
    button.title = managedTitle(this.mark.link);
    button.setAttribute("aria-label", button.title);
    button.innerHTML = gutterIconMarkup("gutter-navigate") ?? "";
    // Keep the editor caret where it was; a normal click then runs the navigation,
    // so the icon also works from the keyboard.
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.open();
    });
    return button;
  }
}

function openGoto(goto: PomGoto): Promise<void> | void {
  return editorService().openFile(goto.path, {
    selection: {
      line: goto.range.start.line,
      col: goto.range.start.col,
      endLine: goto.range.end.line,
      endCol: goto.range.end.col,
    },
  });
}

function openManaged(view: EditorView, target: PomGoto): void {
  void Promise.resolve(openGoto(target)).catch((e: unknown) =>
    showHint(view, e instanceof Error ? e.message : String(e), { tone: "error" }),
  );
}

/** The icon area is shared with run, inheritance and plugin markers; press handling is source-scoped. */
function managedGutter(ctx: EditorDocContext): Extension {
  if (ctx.doc < 0) return [];
  return [
    managedMarksField,
    ViewPlugin.fromClass(
      class {
        private timer: ReturnType<typeof setTimeout> | undefined;
        private generation = 0;
        private inFlight: RequestId | undefined;
        private off: () => void;

        constructor(readonly view: EditorView) {
          this.schedule(0);
          const offEditor = onEditorEvent((event) => {
            if (
              (event.type === "docChanged" || event.type === "docSaved") &&
              event.path !== ctx.path &&
              isMavenPom(event.path)
            )
              this.schedule(500);
          });
          const offFiles = onIdeEvent("fsChanged", (event) => {
            if ([...event.created, ...event.modified, ...event.removed].some(isMavenPom)) this.schedule(500);
          });
          const offRoots = onIdeEvent("projectRootsChanged", () => this.schedule(300));
          const offSettings = onIdeEvent("settingsChanged", (event) => {
            if (event.key.startsWith("languages.java.")) this.schedule(300);
          });
          this.off = () => {
            offEditor();
            offFiles();
            offRoots();
            offSettings();
          };
        }

        update(update: ViewUpdate) {
          if (update.docChanged) this.schedule();
        }

        schedule(delay = 300) {
          clearTimeout(this.timer);
          if (this.inFlight !== undefined) {
            void commands.cancelRequest(this.inFlight);
            this.inFlight = undefined;
          }
          this.timer = setTimeout(() => void this.refresh(), delay);
        }

        async refresh() {
          const generation = ++this.generation;
          const current = this.view.state.doc;
          const request = nextRequestId();
          this.inFlight = request;
          try {
            await whenSynced(this.view);
            if (generation !== this.generation || this.view.state.doc !== current) return;
            const links = await call(commands.mavenManagedDeclarations(ctx.path, request));
            if (generation !== this.generation || this.inFlight !== request || this.view.state.doc !== current) return;
            this.view.dispatch({ effects: setManagedMarks.of(placeManagedMarks(current, links)) });
          } catch (e) {
            if (!isCancelled(e) && generation === this.generation) console.debug("[POM managed dependencies]", e);
          } finally {
            if (this.inFlight === request) this.inFlight = undefined;
          }
        }

        destroy() {
          this.off();
          clearTimeout(this.timer);
          if (this.inFlight !== undefined) void commands.cancelRequest(this.inFlight);
          this.generation++;
        }
      },
    ),
    iconAreaSource.of({
      order: 25,
      markers: (view) =>
        RangeSet.of(
          view.state
            .field(managedMarksField)
            .map((mark) => new ManagedMarker(mark, () => openManaged(view, mark.link.target)).range(mark.pos)),
          true,
        ),
    }),
  ];
}

/** Go to declaration in a POM of the project (or an opened parent POM of the local repository). */
export function pomNavigationExtension(ctx: EditorDocContext): Extension {
  if (ctx.virtual || !isMavenPom(ctx.path)) return [];
  const eligible = (state: EditorState, pos: number) => {
    const text = state.doc.toString();
    return propertyRefAt(text, pos) !== null || inArtifactElement(text, pos);
  };
  const definition: ContributedDefinition = (view, pos) => {
    if (!eligible(view.state, pos)) return false;
    const doc = view.state.doc;
    const line = doc.lineAt(pos);
    void whenSynced(view)
      .then(() =>
        call(
          commands.mavenGotoDeclaration(ctx.path, {
            line: line.number - 1,
            col: pos - line.from,
          }),
        ),
      )
      .then((goto) => {
        if (!goto) {
          showHint(view, tx`Cannot find declaration to go to`);
          return;
        }
        if (view.state.doc !== doc) return; // The user kept typing while the POM resolved.
        void openGoto(goto);
      })
      .catch((e: unknown) =>
        showHint(view, e instanceof Error ? e.message : String(e), {
          tone: "error",
        }),
      );
    return true;
  };
  definition.canHandle = eligible;
  return [
    EditorState.languageData.of((state, pos) =>
      eligible(state, pos) ? [{ [CONTRIBUTED_DEFINITION]: definition }] : [],
    ),
    managedGutter(ctx),
  ];
}
