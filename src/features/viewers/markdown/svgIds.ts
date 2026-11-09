/**
 * Mermaid numbers its markers and scopes its stylesheet under the render's root
 * id. Copies of one drawing in a document — the same diagram twice, or the
 * full-screen preview of a diagram still shown behind it — would share those
 * ids, and Chromium resolves the `url(#…)` references against the hidden copy.
 *
 * Prefix ids so Mermaid's marker suffix selectors keep matching. Rewrite only
 * attributes and CSS rules, leaving diagram labels and CSS colours untouched.
 */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let applied = 0;

export function reid(svg: string): string {
  const tag = /<[a-zA-Z](?:[^>"']|"[^"]*"|'[^']*')*>/g;
  const attribute = /(\s)([\w:-]+)(\s*=\s*)(["'])([\s\S]*?)\4/g;
  const ids = new Set<string>();
  for (const [markup] of svg.matchAll(tag)) {
    for (const attr of markup.matchAll(attribute)) if (attr[2] === "id") ids.add(attr[5]!);
  }
  if (!ids.size) return svg;
  const prefix = `c${++applied}-`;
  const rename = (id: string) => (ids.has(id) ? `${prefix}${id}` : id);
  const pattern = [...ids]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const selector = new RegExp(`#(${pattern})(?=$|[\\s.:>+~\\[,])`, "g");
  const urls = (value: string) =>
    value.replace(
      /(url\(\s*)(["']?)#([^'"\s)]+)(\2\s*\))/g,
      (_m, start: string, quote: string, id: string, end: string) => `${start}${quote}#${rename(id)}${end}`,
    );
  return svg.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)|<[a-zA-Z](?:[^>"']|"[^"]*"|'[^']*')*>/g,
    (markup, open: string | undefined, css: string | undefined, close: string | undefined) => {
      if (css !== undefined) {
        // Only selector lists contain ID selectors; declarations may contain hex colours.
        const scoped = css.replace(
          /(^|[{}])([^{}]+)(?=\{)/g,
          (_m, boundary: string, selectors: string) =>
            boundary + selectors.replace(selector, (_m, id: string) => `#${rename(id)}`),
        );
        return `${open!}${urls(scoped)}${close!}`;
      }
      return markup.replace(
        attribute,
        (_m: string, space: string, name: string, equal: string, quote: string, value: string) => {
          if (name === "id") value = rename(value);
          else if (name === "href" || name === "xlink:href") {
            if (value.startsWith("#")) value = `#${rename(value.slice(1))}`;
          } else if (name === "aria-labelledby" || name === "aria-describedby") value = value.replace(/\S+/g, rename);
          else if (/^(?:style|fill|stroke|filter|clip-path|mask|marker(?:-start|-mid|-end)?|cursor)$/.test(name))
            value = urls(value);
          return `${space}${name}${equal}${quote}${value}${quote}`;
        },
      );
    },
  );
}
