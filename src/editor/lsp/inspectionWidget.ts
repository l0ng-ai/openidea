/**
 * IDEA's inspection widget at the top-right of the editor: problem counts per
 * severity (or a green check), click opens Problems; ˄ / ˅ jump to the
 * previous / next highlighted problem.
 */
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";
import { shortcutLabel } from "@/platform/keymap";
import { editorCorner } from "@/editor/api";
import { toolWindowService } from "@/workbench/contributions";
import { gotoDiagnostic } from "./diagnostics";
import { iconNode } from "@/ui/iconNode";

interface Counts {
  error: number;
  warning: number;
  info: number;
  /** Typo level (Proofreading), counted apart from weak warnings as in IDEA. */
  typo: number;
}

const severityIcons = [
  { severity: "error", icon: "error", tone: "error" },
  { severity: "warning", icon: "warning", tone: "warning" },
  { severity: "info", icon: "warning", tone: "weak" },
  { severity: "typo", icon: "info", tone: "typo" },
] as const;
const MIN_EXPANDED_WIDTH = 360;

export function countsOf(view: EditorView): Counts {
  const c: Counts = { error: 0, warning: 0, info: 0, typo: 0 };
  forEachDiagnostic(view.state, (d) => {
    if (d.markClass?.includes("cm-lsp-unnecessary")) return;
    if (d.markClass?.includes("cm-lsp-typo")) c.typo++;
    else if (d.severity === "error") c.error++;
    else if (d.severity === "warning") c.warning++;
    else if (d.severity === "info") c.info++;
  });
  return c;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-openidea-inspection-button";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", onClick);
  return b;
}

function countItem(icon: string, count: number, tone: string): HTMLElement {
  const item = document.createElement("span");
  item.className = `cm-openidea-inspection-count cm-openidea-inspection-${tone}`;
  item.append(iconNode(icon, 14), String(count));
  return item;
}

class InspectionWidget {
  dom: HTMLElement;
  private key = "";

  constructor(private view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-openidea-inspection";
    this.dom.setAttribute("role", "toolbar");
    this.dom.setAttribute("aria-label", "Inspections");
    editorCorner(view).appendChild(this.dom);
    this.render();
    this.fit();
  }

  update(u: ViewUpdate) {
    if (u.transactions.some((tr) => tr.effects.length) || u.docChanged) this.render();
    if (u.geometryChanged) this.fit();
  }

  private fit() {
    this.view.requestMeasure({
      key: this,
      read: (view) => view.scrollDOM.clientWidth,
      write: (width) => this.dom.toggleAttribute("data-compact", width > 0 && width < MIN_EXPANDED_WIDTH),
    });
  }

  private render() {
    const c = countsOf(this.view);
    const key = `${c.error}/${c.warning}/${c.info}/${c.typo}`;
    if (key === this.key) return;
    this.key = key;
    const open = () => {
      try {
        toolWindowService().show("problems", true);
      } catch {
        // no Problems tool window registered
      }
    };
    const total = c.error + c.warning + c.info + c.typo;
    const summary = button(
      total
        ? `${c.error} errors, ${c.warning} warnings, ${c.info} weak warnings, ${c.typo} typos — open Problems`
        : "No problems found",
      open,
    );
    summary.classList.add("cm-openidea-inspection-summary");
    if (!total) {
      summary.appendChild(iconNode("check", 14, "cm-openidea-inspection-ok"));
      this.dom.replaceChildren(summary);
    } else {
      const counts = document.createElement("span");
      counts.className = "cm-openidea-inspection-counts";
      const severities = severityIcons.filter(({ severity }) => c[severity] > 0);
      counts.append(...severities.map(({ icon, severity, tone }) => countItem(icon, c[severity], tone)));
      summary.append(counts, countItem("problems", total, "total"));
      const prev = button(
        `Previous Highlighted Error${shortcutLabel("navigate.prevError") ? ` (${shortcutLabel("navigate.prevError")})` : ""}`,
        () => {
          gotoDiagnostic(this.view, -1);
          this.view.focus();
        },
      );
      prev.appendChild(iconNode("chevron-up", 14));
      const next = button(
        `Next Highlighted Error${shortcutLabel("navigate.nextError") ? ` (${shortcutLabel("navigate.nextError")})` : ""}`,
        () => {
          gotoDiagnostic(this.view, 1);
          this.view.focus();
        },
      );
      next.appendChild(iconNode("chevron-down", 14));
      const navigation = document.createElement("div");
      navigation.className = "cm-openidea-inspection-navigation";
      navigation.append(prev, next);
      this.dom.replaceChildren(summary, navigation);
    }
  }

  destroy() {
    this.dom.remove();
  }
}

const inspectionPlugin = ViewPlugin.fromClass(InspectionWidget);

const inspectionTheme = EditorView.theme({
  ".cm-openidea-inspection": {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1)",
    padding: "1px",
    borderRadius: "var(--radius-small)",
    backgroundColor: "var(--bg-editor, var(--bg-island, var(--bg-app)))",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-small)",
    fontVariantNumeric: "tabular-nums",
    color: "var(--fg-muted)",
    WebkitUserSelect: "none",
    userSelect: "none",
  },
  ".cm-openidea-inspection-button": {
    display: "inline-flex",
    alignItems: "center",
    height: "22px",
    minWidth: "22px",
    justifyContent: "center",
    padding: "0",
    border: "none",
    borderRadius: "var(--radius-small)",
    background: "none",
    color: "inherit",
    font: "inherit",
  },
  ".cm-openidea-inspection-button:hover": { backgroundColor: "var(--bg-toolbar-hover)" },
  ".cm-openidea-inspection-button:focus-visible": { outline: "1px solid var(--focus-ring)", outlineOffset: "-1px" },
  ".cm-openidea-inspection-summary": { paddingInline: "var(--space-1)" },
  ".cm-openidea-inspection-counts": { display: "inline-flex", alignItems: "center", gap: "var(--space-1-5)" },
  ".cm-openidea-inspection-count": { display: "inline-flex", alignItems: "center", gap: "2px" },
  ".cm-openidea-inspection-total": { display: "none" },
  ".cm-openidea-inspection[data-compact] .cm-openidea-inspection-counts": { display: "none" },
  ".cm-openidea-inspection[data-compact] .cm-openidea-inspection-total": { display: "inline-flex" },
  ".cm-openidea-inspection-navigation": {
    display: "flex",
    alignItems: "center",
    borderInlineStart: "1px solid var(--editor-gutter-border, var(--border))",
    paddingInlineStart: "var(--space-1)",
  },
  ".cm-openidea-icon": { display: "inline-flex", alignItems: "center" },
  ".cm-openidea-inspection-error .cm-openidea-icon": { color: "var(--danger)" },
  ".cm-openidea-inspection-warning .cm-openidea-icon": { color: "var(--warning)" },
  ".cm-openidea-inspection-weak .cm-openidea-icon": { color: "var(--fg-weak-warning, var(--fg-faint))" },
  ".cm-openidea-inspection-typo .cm-openidea-icon": { color: "var(--success)" },
  ".cm-openidea-inspection-ok": { color: "var(--success)" },
});

export function inspectionWidgetExtension() {
  return [inspectionPlugin, inspectionTheme];
}
