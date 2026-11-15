/** Design-system icons as DOM nodes for CodeMirror widgets. */
import { iconMarkupOrFallback, type IconName } from "./icons";

export function iconNode(name: IconName | (string & {}), size = 16, className?: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className ? `cm-openidea-icon ${className}` : "cm-openidea-icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconMarkupOrFallback(name, size);
  return span;
}
