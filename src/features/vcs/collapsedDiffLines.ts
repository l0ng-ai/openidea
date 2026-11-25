import { EditorState, type Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import { tx } from "@/platform/i18n";
import { iconNode } from "@/ui/iconNode";

const collapseButtons = ViewPlugin.define((view) => {
  const enhance = () => {
    for (const row of view.contentDOM.querySelectorAll(".cm-collapsedLines")) {
      if (row.firstElementChild) continue;
      const button = view.dom.ownerDocument.createElement("button");
      button.type = "button";
      button.title = tx("Expand unchanged lines");
      button.setAttribute("aria-expanded", "false");
      const label = view.dom.ownerDocument.createElement("span");
      label.className = "cm-diffCollapseLabel";
      label.textContent = row.textContent;
      button.append(iconNode("chevron-down", 14), label);
      button.addEventListener("click", () => view.focus());
      // The existing widget handles the bubbled click and expands the matching range in both panes.
      row.replaceChildren(button);
    }
  };
  view.requestMeasure({ read: () => null, write: enhance });
  return { docViewUpdate: enhance };
});

export function collapsedDiffLines(): Extension {
  return [EditorState.phrases.of({ "$ unchanged lines": tx("$ unchanged lines") }), collapseButtons];
}
