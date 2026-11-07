import type { PluginIcon } from "@/bindings";
import { registerExternalIcons } from "@/ui/icons";

// ponytail: never unregistered; bounded by the distinct icons seen this session.
const registered = new Set<string>();

/** FNV-1a: a short key for an icon's markup. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

const ROOT_ONLY = new Set(["viewBox", "width", "height", "id", "version"]);

/**
 * `Icon` keeps only the root's viewBox and draws on `fill="none"`: move the
 * root's other attributes onto a group, with SVG's default black fill.
 */
function standalone(svg: string): string {
  const open = svg.indexOf("<svg");
  const start = svg.indexOf(">", open) + 1;
  const end = svg.lastIndexOf("</svg>");
  if (open < 0 || start <= open || end < start) return svg;
  const tag = svg.slice(open, start);
  const inherited = [...tag.matchAll(/\s([\w:-]+)="[^"]*"/g)]
    .filter((m) => !ROOT_ONLY.has(m[1] ?? "") && !m[1]?.startsWith("xmlns"))
    .map((m) => m[0])
    .join("");
  const fill = /\sfill="/.test(inherited) ? "" : ' fill="#000"';
  return `${tag}<g${fill}${inherited}>${svg.slice(start, end)}</g></svg>`;
}

/**
 * The icon name of a plugin's own icon, else the generic one. Names follow the
 * markup, so copies of a plugin with different icons (marketplace, local) keep
 * their own; plugin ids have no `/`, so no id yields another's name or `_dark`.
 */
export function pluginIconName(pluginId: string, icon: PluginIcon | null | undefined): string {
  if (!icon) return "plugin";
  const name = `ext:pluginIcon/${pluginId}/${hash(`${icon.light}\n${icon.dark ?? ""}`)}`;
  if (registered.has(name)) return name;
  registered.add(name);
  registerExternalIcons(
    icon.dark
      ? [
          [name, standalone(icon.light)],
          [`${name}_dark`, standalone(icon.dark)],
        ]
      : [[name, standalone(icon.light)]],
  );
  return name;
}
