/**
 * Inlay hints (settings.editor.inlayHints) for the visible range, refreshed
 * after edits / scrolling (debounced) and rendered as subtle inline widgets.
 * Label parts that name a declaration navigate there on ⌘-click; right-click
 * offers to disable hints of that kind.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { call, commands, isTauri, type InlayHint } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { isNavigationGesture, navigationModifierHeld, onNavigationModifier } from "@/platform/navigationModifier";
import { maybeEditorService } from "@/workbench/contributions";
import { showContextMenu, type MenuItem } from "@/ui";
import { useProject } from "@/platform/project";
import { editorPrefs } from "@/platform/editorSettings";
import { debounce, docOf, isUnavailable, lspRequest } from "./lsp";
import { offsetsToRange, posToOffset } from "./positions";
import { featureBackoff, onLspRefresh } from "./availability";
import { gotoTargets } from "./navigation";
import { tx } from "@/platform/i18n";

const KIND_LABEL: Record<InlayHint["kind"], string> = {
  type: "Type hints",
  parameter: "Parameter name hints",
  other: "Other hints",
};

async function setEditorSetting(key: string, value: unknown) {
  if (!isTauri()) return;
  useProject.setState({ settings: await call(commands.settingsSet("global", `editor.${key}`, JSON.stringify(value))) });
}

const inlayBackoff = featureBackoff();

/** A type hint after an identifier can resolve that identifier's inferred type. */
function typeHintOffset(view: EditorView, at: number): number | null {
  if (at <= 0 || at > view.state.doc.length) return null;
  const word = view.state.wordAt(at - 1);
  return word?.to === at ? word.from : null;
}

/** Right-click on a hint: turn its kind off (IDEA's "Disable '…' hints"), or open the settings. */
export function inlayMenuItems(kind: InlayHint["kind"]): MenuItem[] {
  return [
    { label: tx`Disable ${KIND_LABEL[kind]}`, run: () => void setEditorSetting(`inlay.${kind}`, false) },
    { kind: "separator" },
    { label: "Inlay Hints Settings…", run: () => void executeAction("file.settings", "editor.inlayHints") },
  ];
}

class InlayWidget extends WidgetType {
  constructor(readonly hint: InlayHint) {
    super();
  }
  eq(other: InlayWidget) {
    const a = this.hint,
      b = other.hint;
    return (
      a.label === b.label &&
      a.kind === b.kind &&
      a.paddingLeft === b.paddingLeft &&
      a.paddingRight === b.paddingRight &&
      (a.parts?.length ?? 0) === (b.parts?.length ?? 0) &&
      (a.parts ?? []).every((p, i) => p.location?.path === b.parts[i]?.location?.path && p.value === b.parts[i]?.value)
    );
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = `cm-lsp-inlay cm-lsp-inlay-${this.hint.kind}`;
    if (this.hint.paddingLeft) el.classList.add("cm-lsp-inlay-pl");
    if (this.hint.paddingRight) el.classList.add("cm-lsp-inlay-pr");
    const parts = this.hint.parts ?? [];
    if (parts.some((p) => p.location || p.tooltip)) {
      for (const part of parts) {
        const span = document.createElement("span");
        span.textContent = part.value;
        if (part.tooltip) span.title = part.tooltip;
        if (part.location) {
          span.className = "cm-lsp-inlay-part";
          const loc = part.location;
          // ⌘-click (Ctrl elsewhere) navigates to the declaration the part names, as in IDEA.
          span.addEventListener("mousedown", (e) => {
            if (e.button !== 0 || !isNavigationGesture(e)) return;
            e.preventDefault();
            e.stopPropagation();
            void maybeEditorService()?.openFile(loc.path, {
              selection: { line: loc.range.start.line, col: loc.range.start.col },
              focus: true,
            });
          });
        }
        el.appendChild(span);
      }
    } else el.textContent = this.hint.label;
    // A plain type hint (basedpyright's `: Series`) names no location: ⌘-click opens the preceding identifier's type.
    if (
      this.hint.kind === "type" &&
      !parts.some((p) => p.location) &&
      typeHintOffset(view, posToOffset(view.state.doc, this.hint.position)) !== null
    ) {
      el.classList.add("cm-lsp-inlay-part");
      el.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || !isNavigationGesture(e)) return;
        const offset = typeHintOffset(view, view.posAtDOM(el));
        if (offset === null) return;
        e.preventDefault();
        e.stopPropagation();
        void gotoTargets(view, "typeDefinition", offset);
      });
    }
    if (this.hint.tooltip) el.title = this.hint.tooltip;
    el.setAttribute("aria-hidden", "true");
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.focus();
      showContextMenu(e, inlayMenuItems(this.hint.kind));
    });
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

const setInlays = StateEffect.define<DecorationSet>();

const inlayField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setInlays)) return e.value;
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function inlayDecorations(view: EditorView, hints: readonly InlayHint[]): DecorationSet {
  const doc = view.state.doc;
  return Decoration.set(
    hints.map((h) =>
      Decoration.widget({ widget: new InlayWidget(h), side: h.kind === "parameter" ? 1 : -1 }).range(
        posToOffset(doc, h.position),
      ),
    ),
    true,
  );
}

const enabled = (language: string) =>
  useProject.getState().settings?.editor?.inlayHints !== false &&
  !editorPrefs().inlay.disabledLanguages.includes(language);

/** Inlay Hints settings: per kind (types / parameters / other). */
function shownKind(kind: InlayHint["kind"]): boolean {
  const p = editorPrefs().inlay;
  return kind === "type" ? p.types : kind === "parameter" ? p.parameters : p.other;
}

const inlayPlugin = ViewPlugin.fromClass(
  class {
    private refresh = debounce(() => void this.run(), 400);
    private unsubscribe: () => void;
    private offReady: () => void;
    private offModifier: () => void;
    constructor(private view: EditorView) {
      this.refresh();
      view.contentDOM.classList.toggle("cm-lsp-navigation-modifier", navigationModifierHeld());
      this.offModifier = onNavigationModifier((held) =>
        view.contentDOM.classList.toggle("cm-lsp-navigation-modifier", held),
      );
      this.unsubscribe = useProject.subscribe((s, prev) => {
        if (
          s.settings?.editor?.inlayHints !== prev.settings?.editor?.inlayHints ||
          s.settings?.editor?.inlay !== prev.settings?.editor?.inlay
        )
          this.refresh();
      });
      this.offReady = onLspRefresh("inlayHints", () => this.refresh());
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.refresh();
    }
    async run() {
      const view = this.view;
      if (!view.dom.isConnected) return;
      const doc = docOf(view);
      if (!doc) return;
      if (!enabled(doc.language) || inlayBackoff.active(doc.doc)) {
        if (view.state.field(inlayField).size) view.dispatch({ effects: setInlays.of(Decoration.none) });
        return;
      }
      const state = view.state;
      const { from, to } = view.viewport;
      const first = state.doc.lineAt(from).from;
      const last = state.doc.lineAt(to).to;
      try {
        const hints = await lspRequest(() => commands.lspInlayHints(doc.doc, offsetsToRange(state.doc, first, last)));
        if (view.state.doc !== state.doc) return this.refresh();
        view.dispatch({
          effects: setInlays.of(
            inlayDecorations(
              view,
              hints.filter((h) => shownKind(h.kind)),
            ),
          ),
        });
      } catch (e) {
        if (isUnavailable(e)) inlayBackoff.mark(doc.doc);
      }
    }
    destroy() {
      this.refresh.cancel();
      this.unsubscribe();
      this.offReady();
      this.offModifier();
      this.view.contentDOM.classList.remove("cm-lsp-navigation-modifier");
    }
  },
);

export function inlayExtension(): Extension {
  return [inlayField, inlayPlugin];
}
