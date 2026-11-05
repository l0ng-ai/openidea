/**
 * Watching the active IDE theme: built-in theme, palette theme, plugin theme
 * and accent all live as attributes / inline style on the root element.
 */

/** Theme identity: changes whenever the colours the theme tokens resolve to may change. */
export function themeKey(): string {
  const root = document.documentElement;
  const { theme = "", contrast = "", colorTheme = "", pluginTheme = "" } = root.dataset;
  const accent = root.style.getPropertyValue("--accent");
  // The UI font (the custom one, or its fallback once loaded) is part of how a theme renders.
  const font = getComputedStyle(root).getPropertyValue("--font-ui");
  return `${theme}|${contrast}|${colorTheme}|${pluginTheme}|${accent}|${font}`;
}

/** Calls `cb` when the theme attributes (a plugin theme's included) or the accent on the root change. */
export function subscribeTheme(cb: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-contrast", "data-color-theme", "data-plugin-theme", "style"],
  });
  return () => observer.disconnect();
}
