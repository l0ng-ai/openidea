/**
 * File templates ("New ▸ Rust File", "Kotlin Class"…): naming rules,
 * package inference and body rendering.
 *
 * Body variables: `$NAME$` (the entered name, styled per template),
 * `$PACKAGE$`, `$FILE_NAME$`, `$DATE$`, `$TIME$`, `$YEAR$`, `$USER$`,
 * `$PROJECT_NAME$`, `$END$` (caret); IDEA's `${NAME}` spelling works too. A
 * line mentioning `$PACKAGE$` is dropped, together with one following blank
 * line, when the package is empty. `#parse("File Header")` inserts an include
 * or code template (indented like the directive; a line whose include is
 * empty disappears).
 */
import { formatDate, pascalCase, snakeCase, kebabCase } from "../live/model";
import { BUILTIN_CODE_TEMPLATES, BUILTIN_INCLUDES } from "./builtins";

import type { FileTemplate, FileTemplateKind, NameStyle } from "@/platform/fileTemplates";
export type { FileTemplate, FileTemplateKind, NameStyle } from "@/platform/fileTemplates";

/** A fragment for `#parse` (Includes tab: "File Header") or a Code tab template. */
export interface TemplateFragment {
  /** The name `#parse` refers to, e.g. `File Header`. */
  name: string;
  body: string;
  /** What uses it (Code tab). */
  description?: string;
}

/** Finds the body of an include or code template by its `#parse` name. */
export type IncludeResolver = (name: string) => string | undefined;

export function fragmentResolver(...lists: ReadonlyArray<readonly TemplateFragment[]>): IncludeResolver {
  return (name) => {
    for (const list of lists) {
      // IDEA names carry the extension (`File Header.java`); ours may omit it.
      const hit = list.find((f) => f.name === name) ?? list.find((f) => name.startsWith(`${f.name}.`));
      if (hit) return hit.body;
    }
    return undefined;
  };
}

const builtinResolver = fragmentResolver(BUILTIN_INCLUDES, BUILTIN_CODE_TEMPLATES);

const PARSE_LINE = /^([ \t]*)#parse\(\s*"([^"]+)"\s*\)[ \t]*$/;
const PARSE_INLINE = /#parse\(\s*"([^"]+)"\s*\)/g;

/** Expands `#parse("name")` directives (nested up to a few levels); unknown names stay as written. */
export function expandIncludes(body: string, resolve: IncludeResolver, depth = 0): string {
  if (depth > 4 || !body.includes("#parse")) return body;
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = PARSE_LINE.exec(line);
    if (!m) {
      out.push(
        line.replace(PARSE_INLINE, (all, name: string) => {
          const inc = resolve(name);
          return inc === undefined ? all : expandIncludes(inc.replace(/\n$/, ""), resolve, depth + 1);
        }),
      );
      continue;
    }
    const inc = resolve(m[2]!);
    if (inc === undefined) {
      out.push(line);
      continue;
    }
    const text = expandIncludes(inc.replace(/\r\n?/g, "\n").replace(/\n$/, ""), resolve, depth + 1);
    if (!text) continue;
    const indent = m[1]!;
    for (const l of text.split("\n")) out.push(l ? indent + l : l);
  }
  return out.join("\n");
}

/** The template as seen by `planFile` for `kind` (its extension override applied). */
export function withKind(t: FileTemplate, kind: FileTemplateKind | undefined): FileTemplate {
  return kind?.extension !== undefined && kind.extension !== t.extension ? { ...t, extension: kind.extension } : t;
}

export function styleName(name: string, style: NameStyle): string {
  switch (style) {
    case "snake":
      return snakeCase(name) || name;
    case "pascal":
      return /^[A-Z][A-Za-z0-9]*$/.test(name) ? name : pascalCase(name) || name;
    case "kebab":
      return kebabCase(name) || name;
    default:
      return name;
  }
}

export interface PlannedFile {
  /** Absolute path of the new file. */
  path: string;
  /** Directory the file goes into (may not exist yet). */
  directory: string;
  /** `$NAME$` value. */
  name: string;
  fileName: string;
}

/**
 * Resolves the entered name to a file path: strips a typed extension, allows
 * `sub/dir/name` (and `com.acme.Name` for JVM templates) and applies the
 * template's naming style.
 */
export function planFile(
  t: Pick<FileTemplate, "extension" | "nameStyle" | "dottedPackages" | "fileName">,
  directory: string,
  input: string,
): PlannedFile | null {
  if (t.fileName !== undefined) {
    const fileName = t.fileName;
    const stem = fileName.split(".")[0]!.trimEnd();
    if (
      !fileName ||
      new TextEncoder().encode(fileName).length > 255 ||
      fileName.trim() !== fileName ||
      fileName.endsWith(".") ||
      /[\\/<>:"|?*]/.test(fileName) ||
      Array.from(fileName).some((c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)
    )
      return null;
    const dir = directory.replace(/\/+$/, "");
    const dot = fileName.lastIndexOf(".");
    return { path: `${dir}/${fileName}`, directory: dir, name: dot > 0 ? fileName.slice(0, dot) : fileName, fileName };
  }
  let raw = input
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!raw) return null;
  const ext = t.extension ? `.${t.extension}` : "";
  if (ext && raw.toLowerCase().endsWith(ext.toLowerCase())) raw = raw.slice(0, -ext.length);
  let parts = raw.split("/").filter(Boolean);
  if (t.dottedPackages && parts.length === 1 && /^[\w$]+(\.[\w$]+)+$/.test(parts[0]!)) parts = parts[0]!.split(".");
  if (!parts.length || parts.some((p) => p === "." || p === "..")) return null;
  const last = parts.pop()!;
  const name = styleName(last, t.nameStyle);
  if (!name || /[<>:"|?*]/.test(name)) return null;
  const dir = [directory.replace(/\/+$/, ""), ...parts].join("/");
  const fileName = name + ext;
  return { path: `${dir}/${fileName}`, directory: dir, name, fileName };
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const JVM_ROOTS = new Set(["java", "kotlin", "scala", "groovy"]);

/** Project-relative path of a source / test root (`""` = the content root). */
export type SourceRootPath = string;

const toPackage = (segs: readonly string[]) => {
  const clean = segs.map((s) => s.replace(/-/g, "_"));
  return clean.every((s) => IDENT.test(s)) ? clean.join(".") : "";
};

/**
 * Java/Kotlin package for a directory: the path below the nearest source or
 * test root (`sourceRoots`, from Project Structure and build-file detection),
 * as IDEA does. Without a containing root, conventions apply
 * (`src/main/kotlin/com/acme` → `com.acme`, also `src/commonMain/kotlin/…`,
 * `src/test/java/…`); a plain `src/com/acme` falls back to below `src`.
 */
export function inferJvmPackage(
  directory: string,
  projectRoot: string | null,
  sourceRoots: readonly SourceRootPath[] = [],
): string {
  let rel = directory.replace(/\/+$/, "");
  if (projectRoot && (rel === projectRoot || rel.startsWith(`${projectRoot.replace(/\/+$/, "")}/`)))
    rel = rel.slice(projectRoot.replace(/\/+$/, "").length);
  const segs = rel.split("/").filter(Boolean);
  const relPath = segs.join("/");
  const nearest = sourceRoots
    .filter((r) => !r || relPath === r || relPath.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (nearest !== undefined) return toPackage(segs.slice(nearest.split("/").filter(Boolean).length));
  const srcIdx = segs.lastIndexOf("src");
  let rootIdx = -1;
  for (let i = segs.length - 1; i > srcIdx && srcIdx >= 0; i--) {
    if (JVM_ROOTS.has(segs[i]!)) {
      rootIdx = i;
      break;
    }
  }
  let pkg: string[];
  if (rootIdx >= 0) pkg = segs.slice(rootIdx + 1);
  else if (srcIdx >= 0) {
    pkg = segs.slice(srcIdx + 1);
    // `src/main` without a language root has no package.
    if (["main", "test"].includes(pkg[0] ?? "")) pkg = pkg.slice(1);
  } else pkg = [];
  return toPackage(pkg);
}

/**
 * Go package for a directory: the package of an existing sibling file when
 * known, `main` under `cmd/`, otherwise the sanitized directory name.
 */
export function inferGoPackage(directory: string, projectRoot: string | null, siblingPackage?: string | null): string {
  if (siblingPackage) return siblingPackage;
  const dir = directory.replace(/\/+$/, "");
  const segs = dir.split("/").filter(Boolean);
  const rootSegs = (projectRoot ?? "").split("/").filter(Boolean).length;
  const below = segs.slice(rootSegs);
  if (below.length >= 1 && below.slice(0, -1).includes("cmd")) return "main";
  const base = (segs[segs.length - 1] ?? "main").toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!base || /^\d/.test(base)) return "main";
  return base;
}

export const GO_PACKAGE_RE = /^\s*package\s+([A-Za-z_]\w*)/m;

/** `autoload.psr-4` and `autoload-dev.psr-4` of a composer.json: `[namespace prefix, folder]` (folder relative to it). */
export function composerPsr4(json: string): Array<[string, string]> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const out: Array<[string, string]> = [];
  for (const section of ["autoload", "autoload-dev"]) {
    const map = (data as Record<string, { "psr-4"?: Record<string, unknown> } | undefined> | null)?.[section]?.[
      "psr-4"
    ];
    if (!map || typeof map !== "object") continue;
    for (const [prefix, value] of Object.entries(map)) {
      for (const dir of Array.isArray(value) ? value : [value])
        if (typeof dir === "string")
          out.push([prefix, dir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")]);
    }
  }
  return out;
}

/**
 * PHP namespace for `directory` (relative to the composer.json folder): the PSR-4 prefix of the
 * longest mapped folder that contains it, then the folders below it (`App\\` + `src/` → `src/Http`
 * gives `App\Http`). Outside every mapping: no namespace.
 */
export function inferPhpNamespace(directory: string, psr4: ReadonlyArray<readonly [string, string]>): string {
  const rel = directory.split("/").filter(Boolean);
  let best: { prefix: string; depth: number } | null = null;
  for (const [prefix, dir] of psr4) {
    const segs = dir.split("/").filter((s) => s && s !== ".");
    if (segs.length > rel.length || segs.some((s, i) => s !== rel[i])) continue;
    if (!best || segs.length > best.depth) best = { prefix, depth: segs.length };
  }
  if (!best) return "";
  const parts = [...best.prefix.split("\\").filter(Boolean), ...rel.slice(best.depth)];
  return parts.every((p) => /^[A-Za-z_\x80-\uffff][\w\x80-\uffff]*$/.test(p)) ? parts.join("\\") : "";
}

export interface FileTemplateVars {
  name: string;
  fileName: string;
  packageName?: string;
  projectName?: string;
  user?: string;
  now?: Date;
  variables?: Readonly<Record<string, string>>;
}

/** Renders a body; returns the text and the caret offset (`$END$`, else the end). */
export function renderFileTemplate(
  body: string,
  vars: FileTemplateVars,
  includes: IncludeResolver = builtinResolver,
): { text: string; caret: number } {
  const now = vars.now ?? new Date();
  const values: Record<string, string> = {
    ...vars.variables,
    NAME: vars.name,
    FILE_NAME: vars.fileName,
    PACKAGE: vars.packageName ?? "",
    PACKAGE_NAME: vars.packageName ?? "",
    PROJECT_NAME: vars.projectName ?? "",
    USER: vars.user ?? "",
    DATE: formatDate(now),
    TIME: formatDate(now, "HH:mm"),
    YEAR: String(now.getFullYear()),
  };
  let lines = expandIncludes(body.replace(/\r\n?/g, "\n"), includes).split("\n");
  if (!values.PACKAGE) {
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/\$PACKAGE(_NAME)?\$|\$\{PACKAGE(_NAME)?\}/.test(lines[i]!)) {
        if (lines[i + 1]?.trim() === "") i++;
        continue;
      }
      out.push(lines[i]!);
    }
    lines = out;
  }
  let text = "";
  let caret = -1;
  const src = lines.join("\n");
  let i = 0;
  while (i < src.length) {
    if (src[i] === "$") {
      if (src[i + 1] === "$") {
        text += "$";
        i += 2;
        continue;
      }
      const braced = src[i + 1] === "{";
      const close = braced ? src.indexOf("}", i + 2) : src.indexOf("$", i + 1);
      const key = close > 0 ? src.slice(i + (braced ? 2 : 1), close) : "";
      if (key === "END") {
        if (caret < 0) caret = text.length;
        i = close + 1;
        continue;
      }
      if (Object.hasOwn(values, key)) {
        text += values[key];
        i = close + 1;
        continue;
      }
    }
    text += src[i];
    i++;
  }
  return { text, caret: caret < 0 ? text.length : caret };
}

/** Whether "Reformat according to style" is on (IDEA's default, unless the user turned it off). */
export const reformatsOnCreate = (t: Pick<FileTemplate, "reformat">) => t.reformat !== false;

const isSpace = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";

/**
 * Where the caret (`$END$`) goes after Reformat Code turned `before` into
 * `after`: behind the same number of non-whitespace characters, then on the
 * same line below them (past the new indentation), since formatters mostly
 * change whitespace and may replace the whole text in one edit.
 */
export function caretAfterReformat(before: string, caret: number, after: string): number {
  caret = Math.max(0, Math.min(caret, before.length));
  let tokens = 0;
  let lastToken = -1;
  for (let i = 0; i < caret; i++)
    if (!isSpace(before[i]!)) {
      tokens++;
      lastToken = i;
    }
  const gap = before.slice(lastToken + 1, caret);
  const newlines = gap.split("\n").length - 1;
  let p = 0;
  for (let seen = 0; p < after.length && seen < tokens; p++) if (!isSpace(after[p]!)) seen++;
  if (tokens && p >= after.length) return after.length;
  if (!newlines) {
    // Same line as the token before: keep the spaces typed between them, as far as they still exist.
    let n = gap.length;
    for (; n > 0 && p < after.length && (after[p] === " " || after[p] === "\t"); n--) p++;
    return p;
  }
  let q = p;
  for (let n = 0; n < newlines;) {
    const nl = after.indexOf("\n", q);
    if (nl < 0 || !/^[ \t\r]*$/.test(after.slice(q, nl))) break;
    q = nl + 1;
    n++;
  }
  if (q === p) return p;
  while (q < after.length && (after[q] === " " || after[q] === "\t")) q++;
  return q;
}
