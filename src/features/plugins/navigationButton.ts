import { tx } from "@/platform/i18n";
import { navigateTo, locationItems } from "@/editor/lsp/navigation";
import { openPopup } from "@/editor/lsp/popupStore";
import { gutterIconMarkup, isIconName } from "@/ui/icons";
import type { Location } from "@/platform/ipc";

async function openTargets(targets: Location[], element: HTMLElement) {
  if (targets.length === 1) {
    await navigateTo(targets[0]!);
    return;
  }
  const rect = element.getBoundingClientRect();
  openPopup({
    kind: "list",
    title: "Choose Mapping Target",
    anchor: { x: rect.left, y: rect.bottom + 2 },
    items: await locationItems(targets),
  });
}
/** Shared ordinary-click and keyboard navigation for interactive and indexed markers. */
export function navigationButton(targets: Location[], icon: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-plugin-mapping-button";
  button.title = targets.map((t) => `${t.path.split("/").pop()}:${t.range.start.line + 1}`).join("\n");
  button.setAttribute("aria-label", tx`Go to mapping: ${button.title}`);
  button.innerHTML = gutterIconMarkup(isIconName(icon) ? icon : "arrow-right") ?? "";
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openTargets(targets, button);
  };
  return button;
}
