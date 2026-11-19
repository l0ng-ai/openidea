/** Design-system icons as DOM nodes for CodeMirror widgets. */
import { iconMarkupOrFallback, type IconName } from "./icons";
import spinnerStyles from "./Spinner.module.css";

export function iconNode(name: IconName | (string & {}), size = 16, className?: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className ? `cm-openidea-icon ${className}` : "cm-openidea-icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconMarkupOrFallback(name, size);
  return span;
}

/** The ring `Spinner` as a DOM node for CodeMirror widgets and gutters. */
export function spinnerNode(size = 14, className?: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className ? `cm-openidea-icon ${className}` : "cm-openidea-icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML =
    `<svg class="${spinnerStyles.spinner}" width="${size}" height="${size}" viewBox="0 0 24 24">` +
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="2.4"/>' +
    '<path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' +
    "</svg>";
  return span;
}
