/**
 * Related Symbol for JS/TS components: the files beside one that share its name (Angular
 * `user.component.{ts,html,scss,spec.ts}`, `Button.{tsx,module.css,test.tsx,stories.tsx}`),
 * plus an Angular component's `templateUrl` / `styleUrl(s)`. File names only, no index.
 */
import type { RelatedItem } from "@/editor/relatedProviders";
import { tx } from "@/platform/i18n";

type Group = "source" | "template" | "styles" | "test" | "stories";

const ORDER: Group[] = ["source", "template", "styles", "test", "stories"];
const LABELS: Record<Group, () => string> = {
  source: () => tx("Source File"),
  template: () => tx("Template"),
  styles: () => tx("Styles"),
  test: () => tx("Test"),
  stories: () => tx("Stories"),
};

const STYLES = ["css", "scss", "sass", "less"];
const NAME =
  /^(.+?)(?:\.(module|test|spec|stories))?\.(tsx|jsx|ts|js|mts|cts|mjs|cjs|vue|svelte|html|css|scss|sass|less)$/i;

function parse(name: string): { stem: string; group: Group } | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const qualifier = m[2]?.toLowerCase();
  const ext = m[3]!.toLowerCase();
  const style = STYLES.includes(ext);
  if (qualifier === "module") return style ? { stem: m[1]!, group: "styles" } : null;
  if (qualifier === "test" || qualifier === "spec") return style ? null : { stem: m[1]!, group: "test" };
  if (qualifier === "stories") return style || ext === "html" ? null : { stem: m[1]!, group: "stories" };
  return { stem: m[1]!, group: ext === "html" ? "template" : style ? "styles" : "source" };
}

/** `ref` resolved against the folder `dir` (`./`, `../` and plain names). */
function resolve(dir: string, ref: string): string {
  const parts = dir.split("/");
  for (const seg of ref.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** The files an Angular `@Component` names by `templateUrl`, `styleUrl` and `styleUrls`. */
export function componentUrls(text: string): { ref: string; group: Group }[] {
  const out: { ref: string; group: Group }[] = [];
  const str = /(["'`])([^"'`]+)\1/g;
  for (const m of text.matchAll(/\btemplateUrl\s*:\s*(["'`])([^"'`]+)\1/g)) out.push({ ref: m[2]!, group: "template" });
  for (const m of text.matchAll(/\bstyleUrl\s*:\s*(["'`])([^"'`]+)\1/g)) out.push({ ref: m[2]!, group: "styles" });
  for (const m of text.matchAll(/\bstyleUrls\s*:\s*\[([^\]]*)\]/g))
    for (const s of m[1]!.matchAll(str)) out.push({ ref: s[2]!, group: "styles" });
  return out;
}

/** File names in a folder, or null when it can't be read. */
export type ListDir = (dir: string) => Promise<string[] | null>;

export async function componentFileItems(path: string, text: string, list: ListDir): Promise<RelatedItem[]> {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash);
  const own = parse(path.slice(slash + 1));
  if (!own) return [];
  const found = new Map<string, Group>();
  for (const name of (await list(dir)) ?? []) {
    const p = parse(name);
    // Two sources of one stem (Button.ts beside a compiled Button.js) aren't related.
    if (p?.stem !== own.stem || (p.group === "source" && own.group === "source")) continue;
    found.set(`${dir}/${name}`, p.group);
  }
  if (own.group === "source" && /\.[cm]?tsx?$/i.test(path)) {
    const urls = componentUrls(text).map((u) => ({ ...u, path: resolve(dir, u.ref) }));
    const exists = await Promise.all(
      urls.map(async ({ path: p }) =>
        (await list(p.slice(0, p.lastIndexOf("/"))))?.includes(p.slice(p.lastIndexOf("/") + 1)),
      ),
    );
    urls.forEach((u, i) => {
      if (exists[i] && !found.has(u.path)) found.set(u.path, u.group);
    });
  }
  found.delete(path);
  return [...found]
    .sort(([a, ga], [b, gb]) => ORDER.indexOf(ga) - ORDER.indexOf(gb) || a.localeCompare(b))
    .map(([p, g]) => ({ path: p, group: LABELS[g]() }));
}
