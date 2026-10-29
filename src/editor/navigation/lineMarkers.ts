/**
 * Inheritance line markers: which declarations of a document get an
 * "is implemented / overridden" (↓) or "implements / overrides" (↑) gutter
 * icon, from the language server's answers (implementation requests and the
 * type hierarchy). Pure; the gutter itself is `implementationGutter`.
 */
import type { Location, OutlineItem, SymbolKind } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { identifierAt } from "@/editor/lsp/files";
import { baseName, type SuperMethod } from "./structureNav";

export type MarkerKind = "implemented" | "overridden" | "implementing" | "overriding";

/** Settings › Gutter Icons groups: ↓ markers and ↑ markers. */
export type MarkerGroup = "inheritors" | "supers";

export const MARKER_ICONS: Record<MarkerKind, string> = {
  implemented: "gutter-implemented",
  overridden: "gutter-overridden",
  implementing: "gutter-implementing",
  overriding: "gutter-overriding",
};

export interface MarkerCandidate {
  /** Outline name (`eat(String)` with jdtls), matched against supertypes' members. */
  symbol: string;
  /** Bare name for titles. */
  name: string;
  /** 0-based line / UTF-16 col of the identifier. */
  line: number;
  col: number;
  method: boolean;
  /** Declared abstract: an interface / trait, a member of one, or marked `abstract`. */
  abstract: boolean;
  /** Can have implementations / overriders (asked with an implementation request). */
  inheritable: boolean;
  /** Can implement / override a supertype's method (looked up in the type hierarchy). */
  overriding: boolean;
  /** Identifier position of the enclosing type (methods). */
  owner: { line: number; col: number } | null;
}

export interface LineMarker {
  kind: MarkerKind;
  line: number;
  /** Name of the declaration the marker is on. */
  name: string;
  targets: Location[];
  tooltip: string;
  /** Title of the targets chooser. */
  chooserTitle: string;
}

/** Types whose subtypes / implementations are worth a marker (not structs, enums: they cannot be extended). */
const INHERITABLE_TYPES = new Set<SymbolKind>(["class", "interface", "trait"]);
const ABSTRACT_TYPES = new Set<SymbolKind>(["interface", "trait"]);
/** Types whose methods may implement or override a supertype's. */
const MEMBER_OWNERS = new Set<SymbolKind>(["class", "interface", "trait", "enum", "struct"]);

/** Modifiers that rule out implementations / overriders. */
const NOT_INHERITABLE = /\b(private|static|final)\b/;
const NOT_OVERRIDING = /\b(private|static)\b/;
const ABSTRACT = /\babstract\b/;
/** An interface method with a body (Java `default`). */
const DEFAULT = /\bdefault\b/;

/** The declaration's text before its identifier (annotations and modifiers included). */
function declarationPrefix(item: OutlineItem, lineText: (line: number) => string): string {
  const { start } = item.range;
  const at = item.selection_range.start;
  if (start.line > at.line) return lineText(at.line).slice(0, at.col);
  const lines: string[] = [];
  for (let l = start.line; l <= at.line && lines.length < 12; l++) {
    const text = lineText(l);
    lines.push(
      l === at.line
        ? text.slice(l === start.line ? start.col : 0, at.col)
        : l === start.line
          ? text.slice(start.col)
          : text,
    );
  }
  // Annotation arguments (`@Foo(final = …)`) are not modifiers.
  return lines.join(" ").replace(/@[\w.]+(\([^)]*\))?/g, " ");
}

/** Declarations that may get a marker, in document order. */
export function markerCandidates(
  outline: readonly OutlineItem[],
  lineText: (line: number) => string,
): MarkerCandidate[] {
  const out: MarkerCandidate[] = [];
  const walk = (items: readonly OutlineItem[], parent: OutlineItem | null) => {
    for (const it of items) {
      const prefix = () => declarationPrefix(it, lineText);
      const at = it.selection_range.start;
      if (INHERITABLE_TYPES.has(it.kind)) {
        const p = prefix();
        out.push({
          symbol: it.name,
          name: baseName(it.name),
          line: at.line,
          col: at.col,
          method: false,
          abstract: ABSTRACT_TYPES.has(it.kind) || ABSTRACT.test(p),
          inheritable: !NOT_INHERITABLE.test(p),
          overriding: false,
          owner: null,
        });
      } else if (it.kind === "method" && parent && MEMBER_OWNERS.has(parent.kind)) {
        const p = prefix();
        const inParent = ABSTRACT_TYPES.has(parent.kind);
        out.push({
          symbol: it.name,
          name: baseName(it.name),
          line: at.line,
          col: at.col,
          method: true,
          abstract: (inParent && !DEFAULT.test(p)) || ABSTRACT.test(p),
          inheritable: INHERITABLE_TYPES.has(parent.kind) && !NOT_INHERITABLE.test(p),
          overriding: !NOT_OVERRIDING.test(p),
          owner: parent.selection_range.start,
        });
      }
      if (it.children.length) walk(it.children, it);
    }
  };
  walk(outline, null);
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

export const candidateKey = (c: MarkerCandidate) => `${c.line}:${c.col}:${c.symbol}`;

/** Servers answer an implementation request on a declaration with the declaration itself too. */
export function withoutSelf(path: string, c: MarkerCandidate, targets: readonly Location[]): Location[] {
  return targets.filter((t) => !(t.path === path && t.range.start.line === c.line));
}

const TYPE_DECLARATION = /\b(?:class|interface|trait|object|struct|enum|record|impl)\s+([\p{L}_$][\p{L}\p{N}_$]*)/u;

/** Name of the type a target sits in: the nearest type declaration above it, else the file name. */
export function enclosingTypeName(lines: readonly string[] | null | undefined, target: Location): string {
  for (let l = target.range.start.line - 1; lines && l >= 0 && l >= target.range.start.line - 2000; l--) {
    const m = TYPE_DECLARATION.exec(lines[l] ?? "");
    if (m && !/^\s*(\/\/|\*|\/\*)/.test(lines[l] ?? "")) return m[1]!;
  }
  const file = target.path.split(/[\\/]/).pop() ?? target.path;
  return file.replace(/\.[^.]+$/, "");
}

/** Display name of a target: the type itself for type markers, the type around it for methods. */
export function targetName(lines: readonly string[] | null | undefined, target: Location, method: boolean): string {
  if (!method) {
    const name = identifierAt(lines?.[target.range.start.line] ?? "", target.range.start.col);
    if (name) return name;
  }
  return enclosingTypeName(lines, target);
}

const MAX_NAMES = 8;

function nameList(names: readonly string[]): string {
  const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  const shown = unique.slice(0, MAX_NAMES).join(", ");
  return unique.length > MAX_NAMES ? tx`${shown} and ${unique.length - MAX_NAMES} more` : shown;
}

/** ↓ marker of `c` from its implementations (self excluded already); null without any. */
export function inheritorsMarker(
  c: MarkerCandidate,
  targets: readonly Location[],
  files: ReadonlyMap<string, string[] | null>,
): LineMarker | null {
  if (!targets.length) return null;
  const kind: MarkerKind = c.abstract ? "implemented" : "overridden";
  const names = nameList(targets.map((t) => targetName(files.get(t.path), t, c.method)));
  const n = targets.length;
  let tooltip: string;
  let chooserTitle: string;
  if (!c.method) {
    tooltip = c.abstract ? tx`Is implemented by ${names}` : tx`Is subclassed by ${names}`;
    chooserTitle = c.abstract
      ? tx`Choose Implementation of ${c.name} (${n} found)`
      : tx`Choose Subclass of ${c.name} (${n} found)`;
  } else {
    tooltip = c.abstract ? tx`Is implemented in ${names}` : tx`Is overridden in ${names}`;
    chooserTitle = c.abstract
      ? tx`Choose Implementation of ${c.name} (${n} found)`
      : tx`Choose Overriding Method of ${c.name} (${n} found)`;
  }
  return { kind, line: c.line, name: c.name, targets: [...targets], tooltip, chooserTitle };
}

/** Whether a super method is abstract: declared in an interface / trait, or marked `abstract`. */
export function isAbstractSuper(s: SuperMethod, files: ReadonlyMap<string, string[] | null>): boolean {
  const lines = files.get(s.location.path);
  const prefix = lines ? declarationPrefix(s.method, (l) => lines[l] ?? "") : "";
  return (ABSTRACT_TYPES.has(s.owner.kind) && !DEFAULT.test(prefix)) || ABSTRACT.test(prefix);
}

/** ↑ marker of method `c` from its super methods; null without any. */
export function supersMarker(
  c: MarkerCandidate,
  supers: readonly SuperMethod[],
  files: ReadonlyMap<string, string[] | null>,
): LineMarker | null {
  if (!supers.length) return null;
  // Implementing wins when one of several super methods is abstract, as an interface method would.
  const implementing = supers.some((s) => isAbstractSuper(s, files));
  const owners = nameList(supers.map((s) => baseName(s.owner.name)));
  return {
    kind: implementing ? "implementing" : "overriding",
    line: c.line,
    name: c.name,
    targets: supers.map((s) => s.location),
    tooltip: implementing ? tx`Implements method in ${owners}` : tx`Overrides method in ${owners}`,
    chooserTitle: tx`Choose Super Method of ${c.name} (${supers.length} found)`,
  };
}
