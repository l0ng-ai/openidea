/**
 * Gradle version catalogs (`gradle/libs.versions.toml`, catalogs declared in settings): in a build
 * script, Go to Declaration on `libs.spring.boot.starter` opens that alias in the TOML file and hover
 * shows its declaration; in a catalog, `version.ref = "x"` and bundle members go to their entries.
 * Read from the files themselves (no Gradle run), and re-read when a catalog or settings file changes.
 */
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  CONTRIBUTED_DEFINITION,
  CONTRIBUTED_HOVER,
  type ContributedDefinition,
  type ContributedHover,
  type EditorDocContext,
} from "@/editor/api";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { dirname, useProject } from "@/platform/project";
import { editorService } from "@/workbench/contributions";

type Section = "versions" | "libraries" | "bundles" | "plugins";

export interface CatalogEntry {
  section: Section;
  alias: string;
  /** 0-based line and UTF-16 column of the alias. */
  line: number;
  col: number;
  /** The declaration's value as written (first line). */
  value: string;
}

export interface Catalog {
  /** Accessor name in build scripts (`libs`). */
  name: string;
  path: string;
  entries: CatalogEntry[];
}

const SECTIONS: ReadonlySet<string> = new Set(["versions", "libraries", "bundles", "plugins"]);

/** Top-level keys of the catalog's four tables, with where they are declared. */
export function parseCatalog(name: string, path: string, text: string): Catalog {
  const entries: CatalogEntry[] = [];
  let section: Section | null = null;
  let depth = 0;
  text.split("\n").forEach((raw, line) => {
    const header = depth === 0 ? /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(raw) : null;
    if (header) {
      const t = header[1]!.trim();
      section = SECTIONS.has(t) ? (t as Section) : null;
      return;
    }
    if (section && depth === 0) {
      const key = /^(\s*)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))[^=]*?=\s*(.*)$/.exec(raw);
      if (key) {
        const alias = key[2] ?? key[3] ?? key[4]!;
        const col = key[1]!.length + (key[4] === undefined ? 1 : 0);
        if (!entries.some((e) => e.section === section && e.alias === alias))
          entries.push({ section, alias, line, col, value: key[5]!.replace(/\s+#.*$/, "").trim() });
      }
    }
    // A bundle's array may span lines.
    for (const ch of raw.replace(/"[^"]*"|'[^']*'|#.*$/g, "")) {
      if (ch === "[" || ch === "{") depth++;
      else if ((ch === "]" || ch === "}") && depth > 0) depth--;
    }
  });
  return { name, path, entries };
}

/** Gradle's accessor for an alias: `-`, `_` and `.` all separate segments. */
export function accessorSegments(alias: string): string[] {
  return alias.split(/[-_.]/).filter(Boolean);
}

/** The entry `segments` (after the catalog name) refer to: the longest prefix that names one. */
export function catalogEntry(catalog: Catalog, segments: readonly string[]): CatalogEntry | null {
  const [first, ...rest] = segments;
  const section: Section = first === "versions" || first === "bundles" || first === "plugins" ? first : "libraries";
  const path = section === "libraries" ? segments : rest;
  for (let n = path.length; n > 0; n--) {
    const want = path.slice(0, n).join(".");
    const hit = catalog.entries.find((e) => e.section === section && accessorSegments(e.alias).join(".") === want);
    if (hit) return hit;
  }
  return null;
}

/** The dotted accessor chain around `pos` in `line`, e.g. `libs.spring.boot.starter`. */
export function chainAt(line: string, pos: number): { from: number; to: number; segments: string[] } | null {
  const word = /[A-Za-z0-9_]/;
  let from = pos;
  while (from > 0 && (word.test(line[from - 1]!) || (line[from - 1] === "." && word.test(line[from - 2] ?? ""))))
    from--;
  let to = pos;
  while (to < line.length && (word.test(line[to]!) || (line[to] === "." && word.test(line[to + 1] ?? "")))) to++;
  if (to <= from || !/^[A-Za-z_]/.test(line[from]!)) return null;
  const segments = line.slice(from, to).split(".");
  return segments.length > 1 ? { from, to, segments } : null;
}

export type DeclaredCatalog = { name: string; file: string } | { name: string; artifact: string };

/**
 * Catalogs declared in settings: `create("name") { from(files("path")) }`, paths relative to the
 * build root, or `create("name") { from("group:artifact:version") }`, a published catalog.
 */
export function declaredCatalogs(settings: string): DeclaredCatalog[] {
  const out: DeclaredCatalog[] = [];
  const re =
    /create\(\s*["'](\w+)["']\s*\)\s*\{[^}]*?from\(\s*(?:files\(\s*["']([^"']+)["']|["']([^"':]+:[^"':]+:[^"']+)["'])/g;
  for (let m = re.exec(settings); m; m = re.exec(settings))
    out.push(m[2] !== undefined ? { name: m[1]!, file: m[2] } : { name: m[1]!, artifact: m[3]! });
  return out;
}

const readText = (path: string) => call(commands.fsReadText(path)).catch(() => null);
const join = (dir: string, rel: string) => (rel.startsWith("/") ? rel : `${dir}/${rel.replace(/^\.\//, "")}`);

/**
 * The catalogs a build script sees: those of the nearest enclosing build (its settings file).
 * `complete` is false while a published catalog isn't downloaded yet.
 */
export async function readCatalogs(script: string, root: string): Promise<{ catalogs: Catalog[]; complete: boolean }> {
  let dir = dirname(script);
  let settings: string | null = null;
  for (;;) {
    settings = (await readText(`${dir}/settings.gradle.kts`)) ?? (await readText(`${dir}/settings.gradle`));
    if (settings !== null || dir === root || !dir.startsWith(`${root}/`)) break;
    dir = dirname(dir);
  }
  const buildRoot = settings !== null ? dir : root;
  const declared = declaredCatalogs(settings ?? "");
  if (!declared.some((d) => d.name === "libs")) declared.push({ name: "libs", file: "gradle/libs.versions.toml" });
  const catalogs = await Promise.all(
    declared.map(async (d) => {
      const path =
        "file" in d
          ? join(buildRoot, d.file)
          : await call(commands.gradlePublishedCatalog(d.artifact)).catch(() => null);
      const text = path ? await readText(path) : null;
      return text === null ? null : parseCatalog(d.name, path!, text);
    }),
  );
  const complete = declared.every((d, i) => "file" in d || catalogs[i] !== null);
  return { catalogs: catalogs.filter((c): c is Catalog => c !== null), complete };
}

const loaded = new Map<string, Catalog[]>();
const pending = new Map<string, Promise<Catalog[]>>();
let offFs: (() => void) | null = null;

function load(script: string): void {
  const root = useProject.getState().project?.root;
  if (!root || pending.has(script)) return;
  offFs ??= onIdeEvent("fsChanged", (e) => {
    const touched = [...e.created, ...e.modified, ...e.removed].some((p) =>
      /(\.versions\.toml|\/settings\.gradle(\.kts)?)$/.test(p),
    );
    if (!touched) return;
    const scripts = [...loaded.keys()];
    pending.clear();
    scripts.forEach(load);
  });
  const p = readCatalogs(script, root).then(({ catalogs, complete }) => {
    if (pending.get(script) !== p) return catalogs;
    loaded.set(script, catalogs);
    // Read again when the script is next opened, once a build has downloaded the catalog.
    if (!complete) pending.delete(script);
    return catalogs;
  });
  pending.set(script, p);
}

function open(entry: CatalogEntry, path: string) {
  void editorService().openFile(path, {
    selection: { line: entry.line, col: entry.col, endLine: entry.line, endCol: entry.col + entry.alias.length },
  });
}

function hoverText(catalog: Catalog, entry: CatalogEntry): string {
  const lines = [`\`\`\`toml\n${entry.alias} = ${entry.value}\n\`\`\``];
  const ref = /\bref\s*=\s*["']([^"']+)["']/.exec(entry.value)?.[1];
  const version = ref && catalog.entries.find((e) => e.section === "versions" && e.alias === ref);
  if (version) lines.push(`\`${ref}\` = \`${version.value.replace(/^["']|["']$/g, "")}\``);
  lines.push(catalog.path.slice(catalog.path.lastIndexOf("/") + 1));
  return lines.join("\n\n");
}

/** Build scripts: catalog accessors navigate to and describe their TOML entries. */
function scriptSupport(ctx: EditorDocContext): Extension {
  load(ctx.path);
  const at = (state: EditorState, pos: number) => {
    const line = state.doc.lineAt(pos);
    const chain = chainAt(line.text, pos - line.from);
    if (!chain) return null;
    const catalog = loaded.get(ctx.path)?.find((c) => c.name === chain.segments[0]);
    const entry = catalog && catalogEntry(catalog, chain.segments.slice(1));
    return entry ? { catalog, entry, from: line.from + chain.from, to: line.from + chain.to } : null;
  };
  const definition: ContributedDefinition = (view, pos) => {
    const hit = at(view.state, pos);
    if (!hit) return false;
    open(hit.entry, hit.catalog.path);
    return true;
  };
  const hover: ContributedHover = (state, pos) => {
    const hit = at(state, pos);
    return hit && { from: hit.from, to: hit.to, markdown: hoverText(hit.catalog, hit.entry) };
  };
  return EditorState.languageData.of((state, pos) =>
    at(state, pos) ? [{ [CONTRIBUTED_DEFINITION]: definition, [CONTRIBUTED_HOVER]: hover }] : [],
  );
}

/** Catalog files: `version.ref = "x"` goes to `[versions] x`, a bundle member to its library. */
function catalogSupport(ctx: EditorDocContext): Extension {
  const at = (state: EditorState, pos: number) => {
    const line = state.doc.lineAt(pos);
    const col = pos - line.from;
    const str = [...line.text.matchAll(/"([^"]*)"|'([^']*)'/g)].find(
      (m) => m.index! < col && col < m.index! + m[0].length,
    );
    if (!str) return null;
    const catalog = parseCatalog("", ctx.path, state.doc.toString());
    const name = str[1] ?? str[2]!;
    const isRef = /\bref\s*=\s*$/.test(line.text.slice(0, str.index));
    const inBundle = !isRef && sectionAt(state, line.number - 1) === "bundles";
    if (!isRef && !inBundle) return null;
    const section: Section = isRef ? "versions" : "libraries";
    const entry = catalog.entries.find((e) => e.section === section && e.alias === name);
    return entry ? { catalog, entry, from: line.from + str.index!, to: line.from + str.index! + str[0].length } : null;
  };
  const definition: ContributedDefinition = (view: EditorView, pos) => {
    const hit = at(view.state, pos);
    if (!hit) return false;
    const line = view.state.doc.line(hit.entry.line + 1);
    view.dispatch({
      selection: { anchor: line.from + hit.entry.col, head: line.from + hit.entry.col + hit.entry.alias.length },
      scrollIntoView: true,
    });
    return true;
  };
  const hover: ContributedHover = (state, pos) => {
    const hit = at(state, pos);
    return hit && { from: hit.from, to: hit.to, markdown: hoverText(hit.catalog, hit.entry) };
  };
  return EditorState.languageData.of((state, pos) =>
    at(state, pos) ? [{ [CONTRIBUTED_DEFINITION]: definition, [CONTRIBUTED_HOVER]: hover }] : [],
  );
}

function sectionAt(state: EditorState, line: number): string | null {
  for (let n = line; n >= 0; n--) {
    const m = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(state.doc.line(n + 1).text);
    if (m) return m[1]!.trim();
  }
  return null;
}

export function versionCatalogExtension(ctx: EditorDocContext): Extension {
  if (ctx.virtual) return [];
  if (/\.gradle(\.kts)?$/.test(ctx.path)) return scriptSupport(ctx);
  if (ctx.path.endsWith(".versions.toml")) return catalogSupport(ctx);
  return [];
}
