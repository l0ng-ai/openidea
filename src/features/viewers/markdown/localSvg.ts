/**
 * A drawing with nothing in it that fetches from another host when it is shown. Mermaid puts a
 * diagram's `style` and `classDef` values into CSS as written and keeps `<img>` in HTML labels,
 * so the text of a file, or of an agent's reply, could otherwise reach any address on render.
 * Links stay: they are followed only on a click.
 */

/** Whether the webview would read `value` as an address on another host: it drops blanks and takes `\` for `/`. */
const namesHost = (value: string) =>
  /^(https?:|[\\/]{2})/i.test([...value].filter((c) => c.charCodeAt(0) > 32).join(""));

/** CSS that names nothing outside the drawing: `url(#marker)` and inline data stay. */
function localCss(css: string): string {
  return (
    css
      // An escape can spell `url` or an address without the letters a filter looks for.
      .replace(/\\[0-9a-f]{1,6}\s?|\\[\s\S]?/gi, "")
      .replace(/@import[^;]*;?/gi, "")
      .replace(/url\((?!\s*["']?\s*(?:#|data:))[^)]*\)?/gi, "none")
      // `image-set("…")` and the like take an address as a plain string. Strings are matched
      // whole, from their opening quote, so the rules between two of them stay.
      .replace(/"[^"]*"|'[^']*'/g, (string) =>
        /^["']\s*(?:#|data:)/i.test(string) || !/[/:]/.test(string) ? string : '""',
      )
  );
}

/** `svg` parsed where nothing loads, without what would fetch from another host. */
export function localSvg(svg: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = svg;
  for (const element of template.content.querySelectorAll("*")) {
    if (element.localName === "style") element.textContent = localCss(element.textContent ?? "");
    for (const { name, value } of [...element.attributes]) {
      if (
        (name === "href" && element.localName === "a") ||
        name === "alt" ||
        name === "title" ||
        name.startsWith("aria-")
      )
        continue;
      if (name === "srcset" || namesHost(value)) element.removeAttribute(name);
      else if (name === "style" || /url\(|\\/i.test(value)) element.setAttribute(name, localCss(value));
    }
  }
  return template.content;
}
